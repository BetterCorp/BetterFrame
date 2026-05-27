/**
 * Minimal ONVIF discovery client.
 *
 * Talks SOAP/HTTP directly (no external ONVIF library). Covers the v0.1
 * happy path: GetProfiles + GetStreamUri against the standard media service.
 * Uses WS-Security UsernameToken auth (clear-text password digest variant
 * skipped — most cameras accept plain text over LAN; we can upgrade later).
 *
 * Why not the `onvif` npm package? CJS, callback API, no TypeScript types.
 * A 50-line SOAP wrapper is easier to maintain than wrapping callbacks.
 */
import { createHash, randomBytes } from "node:crypto";

export interface DiscoveredProfile {
  profile_name: string;
  profile_token: string;
  source_token: string | null;
  encoding: string | null;
  width: number | null;
  height: number | null;
  framerate: number | null;
  stream_uri: string;
  snapshot_uri: string | null;
  role: "main" | "sub" | "other";
}

export interface DiscoveredCamera {
  name: string;
  source_token: string | null;
  profiles: DiscoveredProfile[];
}

interface DiscoverInput {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Path of the media service endpoint. Most cameras serve at /onvif/device_service for device + /onvif/Media for media. */
  mediaPath?: string;
  /** Optional timeout in ms (default 8s). */
  timeoutMs?: number;
  soapTransport?: SoapTransport;
}

export type SoapTransport = (
  url: string,
  action: string,
  body: string,
  timeoutMs: number,
) => Promise<string>;

interface EndpointParts {
  origin: string;
  deviceUrl: string;
  explicitMediaUrl: string | null;
}

function wsseHeader(username: string, password: string): string {
  // WS-Security UsernameToken with PasswordDigest (the ONVIF-standard form).
  // PasswordDigest = Base64( SHA1( nonce + created + password ) )
  const nonceRaw = randomBytes(16);
  const nonce = nonceRaw.toString("base64");
  const created = new Date().toISOString();
  const digest = createHash("sha1")
    .update(Buffer.concat([nonceRaw, Buffer.from(created, "utf8"), Buffer.from(password, "utf8")]))
    .digest("base64");
  return `
    <s:Header>
      <Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
        <UsernameToken>
          <Username>${escapeXml(username)}</Username>
          <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
          <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</Nonce>
          <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>
        </UsernameToken>
      </Security>
    </s:Header>`;
}

function optionalWsseHeader(username: string, password: string): string {
  return username ? wsseHeader(username, password) : "";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function soap(
  url: string,
  action: string,
  body: string,
  timeoutMs: number,
  transport?: SoapTransport,
): Promise<string> {
  if (transport) return transport(url, action, body, timeoutMs);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `application/soap+xml; charset=utf-8; action="${action}"`,
        "SOAPAction": action,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ONVIF ${action} HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
    }
    return text;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`ONVIF ${action} timed out after ${String(timeoutMs)}ms`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function trySoap(
  url: string,
  action: string,
  body: string,
  timeoutMs: number,
  transport?: SoapTransport,
): Promise<string | null> {
  try {
    return await soap(url, action, body, timeoutMs, transport);
  } catch {
    return null;
  }
}

function buildEnvelope(headerXml: string, bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema">
  ${headerXml}
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

// Extract all occurrences of a SOAP element value or attribute via regex.
// XML parsing in regex is regrettable but adequate for ONVIF's small, stable
// schema. Falls back to empty string when not found.
function pickAll(xml: string, tagLocalName: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tagLocalName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tagLocalName}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push((m[1] ?? "").trim());
  }
  return out;
}

function pickAttr(xml: string, tagLocalName: string, attr: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tagLocalName}\\b[^>]*\\b${attr}="([^"]*)"`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push(m[1] ?? "");
  }
  return out;
}

function pickFirstXAddr(parentXml: string, tagLocalName: string): string | null {
  const block = pickNested(parentXml, tagLocalName);
  if (!block) return null;
  return pickNested(block, "XAddr");
}

function normalizeEndpoint(input: DiscoverInput): EndpointParts {
  const raw = input.host.trim();
  const port = input.port || 80;

  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    const resolvedPort = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : port;
    const origin = `${u.protocol}//${u.hostname}:${String(resolvedPort)}`;
    const path = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return {
      origin,
      deviceUrl: path ? `${origin}${path}` : `${origin}/onvif/device_service`,
      explicitMediaUrl: path ? `${origin}${path}` : null,
    };
  }

  const origin = `http://${raw}:${String(port)}`;
  return {
    origin,
    deviceUrl: `${origin}/onvif/device_service`,
    explicitMediaUrl: null,
  };
}

async function discoverMediaUrl(
  input: DiscoverInput,
  endpoint: EndpointParts,
  timeoutMs: number,
  transport?: SoapTransport,
): Promise<string> {
  if (input.mediaPath) {
    return `${endpoint.origin}${input.mediaPath.startsWith("/") ? input.mediaPath : `/${input.mediaPath}`}`;
  }

  if (endpoint.explicitMediaUrl) {
    return endpoint.explicitMediaUrl;
  }

  const capabilitiesEnv = buildEnvelope(
    optionalWsseHeader(input.username, input.password),
    `<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>`,
  ).replace(
    'xmlns:tt="http://www.onvif.org/ver10/schema">',
    'xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">',
  );
  const capabilitiesXml = await trySoap(
    endpoint.deviceUrl,
    "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
    capabilitiesEnv,
    timeoutMs,
    transport,
  );
  if (capabilitiesXml) {
    const mediaXAddr = pickFirstXAddr(capabilitiesXml, "Media");
    if (mediaXAddr) return mediaXAddr;
  }

  // Common vendor endpoints. Prefer lower-case media_service because many NVRs
  // advertise that path and return 404 for /onvif/Media.
  return `${endpoint.origin}/onvif/media_service`;
}

// Pull a single nested value from a parent element block.
function pickNested(parentXml: string, tagLocalName: string): string | null {
  const m = parentXml.match(new RegExp(`<(?:[\\w-]+:)?${tagLocalName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tagLocalName}>`));
  return m ? (m[1] ?? "").trim() : null;
}

// Split the response into Profile blocks so we can read per-profile sub-elements.
function splitProfiles(xml: string): string[] {
  const re = /<(?:[\w-]+:)?Profiles\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Profiles>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push(m[1] ?? "");
  }
  return out;
}

function streamArea(p: DiscoveredProfile): number {
  return (p.width ?? 0) * (p.height ?? 0);
}

function roleProfiles(profiles: DiscoveredProfile[]): DiscoveredProfile[] {
  const ordered = [...profiles].sort((a, b) => streamArea(b) - streamArea(a));
  const roles = new Map<DiscoveredProfile, "main" | "sub" | "other">();
  for (let i = 0; i < ordered.length; i += 1) {
    roles.set(ordered[i]!, i === 0 ? "main" : i === 1 ? "sub" : "other");
  }
  return profiles.map((p) => ({ ...p, role: roles.get(p) ?? "other" }));
}

function profileGroupKey(profileName: string, sourceToken: string | null, streamUri: string): string {
  if (sourceToken) return `source:${sourceToken}`;
  const match = streamUri.match(/(?:channel|channels|video|cam|camera)[/_-]?(\d+)/i)
    ?? profileName.match(/(?:channel|channels|video|cam|camera|profile)[/_ -]?(\d+)/i);
  return match?.[1] ? `channel:${match[1]}` : "source:default";
}

function groupProfiles(host: string, deviceName: string | null, profiles: DiscoveredProfile[]): DiscoveredCamera[] {
  const groups = new Map<string, DiscoveredProfile[]>();
  for (const profile of profiles) {
    const key = profileGroupKey(profile.profile_name, profile.source_token, profile.stream_uri);
    groups.set(key, [...(groups.get(key) ?? []), profile]);
  }

  const base = deviceName || host;
  const out: DiscoveredCamera[] = [];
  let i = 1;
  for (const [key, group] of groups) {
    const sourceToken = group.find((p) => p.source_token)?.source_token ?? null;
    const name = groups.size === 1
      ? base
      : sourceToken ? `${base} ${sourceToken}` : `${base} camera ${String(i)}`;
    out.push({
      name,
      source_token: sourceToken ?? (key.startsWith("channel:") ? key.slice("channel:".length) : null),
      profiles: roleProfiles(group),
    });
    i += 1;
  }
  return out;
}

/**
 * Connect to an ONVIF camera and list its media profiles with their
 * resolutions, encodings, and RTSP stream URIs.
 *
 * Throws on transport error. Profile fields default to null if the camera
 * omits them.
 */
export async function discover(input: DiscoverInput): Promise<DiscoveredCamera[]> {
  const timeoutMs = input.timeoutMs ?? 8000;
  const endpoint = normalizeEndpoint(input);
  const mediaUrl = await discoverMediaUrl(input, endpoint, timeoutMs, input.soapTransport);

  const header = wsseHeader(input.username, input.password);

  // ---- GetDeviceInformation (best-effort, for friendly device name) ---------
  let deviceName: string | null = null;
  try {
    const devInfoEnv = buildEnvelope(header, `<tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>`);
    const devInfoXml = await soap(
      endpoint.deviceUrl,
      "http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation",
      devInfoEnv,
      timeoutMs,
      input.soapTransport,
    );
    // Try Manufacturer + Model as combined name (e.g. "Hikvision DS-2CD2146G2")
    const manufacturer = pickAll(devInfoXml, "Manufacturer")[0]?.trim() ?? null;
    const model = pickAll(devInfoXml, "Model")[0]?.trim() ?? null;
    if (manufacturer && model) {
      deviceName = `${manufacturer} ${model}`;
    } else {
      deviceName = manufacturer ?? model ?? null;
    }
  } catch {
    // Device info is optional — some cameras gate it behind auth or omit it.
  }

  // ---- GetProfiles -----------------------------------------------------------
  const profilesEnv = buildEnvelope(header, `<trt:GetProfiles/>`);
  const profilesXml = await soap(
    mediaUrl,
    "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
    profilesEnv,
    timeoutMs,
    input.soapTransport,
  );

  const profileBlocks = splitProfiles(profilesXml);
  const tokenAttrs = pickAttr(profilesXml, "Profiles", "token");

  if (profileBlocks.length === 0) {
    const preview = profilesXml.slice(0, 500);
    throw new Error(`GetProfiles returned 0 profiles. mediaUrl=${mediaUrl} response preview: ${preview}`);
  }

  const out: DiscoveredProfile[] = [];
  for (let i = 0; i < profileBlocks.length; i += 1) {
    const block = profileBlocks[i] ?? "";
    const token = tokenAttrs[i] ?? "";
    const profileName = pickNested(block, "Name") ?? token ?? `profile_${String(i)}`;
    const vsrc = pickNested(block, "VideoSourceConfiguration") ?? "";
    const sourceToken = vsrc
      ? pickNested(vsrc, "SourceToken") ?? pickAttr(vsrc, "VideoSourceConfiguration", "token")[0] ?? null
      : null;

    // VideoEncoderConfiguration → Encoding, Resolution{Width,Height}, RateControl.FrameRateLimit
    const venc = pickNested(block, "VideoEncoderConfiguration") ?? "";
    const encoding = venc ? pickNested(venc, "Encoding") : null;
    const resBlock = venc ? pickNested(venc, "Resolution") : null;
    const width = resBlock ? Number(pickNested(resBlock, "Width") ?? "") || null : null;
    const height = resBlock ? Number(pickNested(resBlock, "Height") ?? "") || null : null;
    const rateCtrl = venc ? pickNested(venc, "RateControl") : null;
    const framerate = rateCtrl ? Number(pickNested(rateCtrl, "FrameRateLimit") ?? "") || null : null;

    // ---- GetStreamUri for this profile -------------------------------------
    const streamBody = `<trt:GetStreamUri>
      <trt:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
      </trt:StreamSetup>
      <trt:ProfileToken>${escapeXml(token)}</trt:ProfileToken>
    </trt:GetStreamUri>`;
    const streamEnv = buildEnvelope(wsseHeader(input.username, input.password), streamBody);
    let streamXml: string;
    try {
      streamXml = await soap(
        mediaUrl,
        "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
        streamEnv,
        timeoutMs,
        input.soapTransport,
      );
    } catch {
      continue; // skip profiles we can't get a stream uri for
    }
    const uri = pickAll(streamXml, "Uri")[0] ?? "";
    if (!uri) continue;
    const snapshotBody = `<trt:GetSnapshotUri>
      <trt:ProfileToken>${escapeXml(token)}</trt:ProfileToken>
    </trt:GetSnapshotUri>`;
    const snapshotEnv = buildEnvelope(wsseHeader(input.username, input.password), snapshotBody);
    let snapshotUri: string | null = null;
    try {
      const snapshotXml = await soap(
        mediaUrl,
        "http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri",
        snapshotEnv,
        timeoutMs,
        input.soapTransport,
      );
      snapshotUri = pickAll(snapshotXml, "Uri")[0] ?? null;
    } catch {
      snapshotUri = null;
    }

    out.push({
      profile_name: profileName,
      profile_token: token,
      source_token: sourceToken,
      encoding,
      width,
      height,
      framerate,
      stream_uri: uri,
      snapshot_uri: snapshotUri,
      role: "other",
    });
  }

  return groupProfiles(input.host, deviceName, out);
}

/**
 * Query the camera's supported ONVIF event topics via GetEventProperties.
 * Returns a list of topic strings the camera can produce (e.g.
 * "tns1:RuleEngine/CellMotionDetector/Motion",
 * "tns1:RuleEngine/LicensePlateRecognition/Plate", etc.).
 *
 * Best-effort: returns [] on failure (camera might not support events,
 * auth might fail, event service might be at a non-standard path).
 */
export async function getEventProperties(input: DiscoverInput): Promise<string[]> {
  const timeoutMs = input.timeoutMs ?? 8000;
  const endpoint = normalizeEndpoint(input);
  const header = wsseHeader(input.username, input.password);
  const eventUrl = `${endpoint.origin}/onvif/event_service`;

  const body = buildEnvelope(header,
    `<tev:GetEventProperties xmlns:tev="http://www.onvif.org/ver10/events/wsdl"/>`);

  let xml: string;
  try {
    xml = await soap(eventUrl,
      "http://www.onvif.org/ver10/events/wsdl/EventPortType/GetEventPropertiesRequest",
      body, timeoutMs, input.soapTransport);
  } catch {
    return [];
  }

  // Parse TopicSet — extract all topic paths. ONVIF nests topics as XML
  // elements under TopicSet. Each leaf element with wstop:topic="true" is
  // a subscribable topic. The full path is the concatenation of ancestor
  // element names separated by "/".
  const topics: string[] = [];

  // Strategy: find all elements with topic="true" attribute and walk
  // their path. Simpler: extract all text between <TopicSet> and
  // </TopicSet>, find elements with topic="true", reconstruct paths.
  const topicSetMatch = xml.match(/<[^:]*:?TopicSet[^>]*>([\s\S]*?)<\/[^:]*:?TopicSet>/);
  if (!topicSetMatch) return topics;
  const topicSetXml = topicSetMatch[1] ?? "";

  // Walk the XML naively: track element depth + names.
  const stack: string[] = [];
  const tagRe = /<\/?([^\s>\/]+)[^>]*?(\/?)>/g;
  let match;
  while ((match = tagRe.exec(topicSetXml)) !== null) {
    const full = match[0]!;
    const tagName = match[1]!;
    const selfClose = match[2] === "/";
    const isClose = full.startsWith("</");

    // Strip namespace prefix for the path name.
    const localName = tagName.includes(":") ? tagName.split(":").pop()! : tagName;

    if (isClose) {
      stack.pop();
    } else {
      stack.push(localName);
      // Check if this element has topic="true"
      if (full.includes('topic="true"') || full.includes("topic='true'")) {
        // Reconstruct topic path: tns1:TopLevel/Sub/Leaf
        // Convention: first element under TopicSet gets "tns1:" prefix.
        const path = stack.join("/");
        const topicPath = stack.length > 0 ? `tns1:${path}` : path;
        topics.push(topicPath);
      }
      if (selfClose) {
        stack.pop();
      }
    }
  }

  return topics;
}
