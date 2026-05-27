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
  username?: string,
  password?: string,
) => Promise<string>;

interface EndpointParts {
  origin: string;
  deviceUrl: string;
  explicitMediaUrl: string | null;
}

interface ServiceAddresses {
  mediaUrl: string;
  eventUrl: string;
  ptzUrl: string | null;
  imagingUrl: string | null;
  deviceIoUrl: string | null;
  capabilitiesXml: string | null;
}

export type OnvifActionName =
  | "ptz.get_status"
  | "ptz.get_nodes"
  | "ptz.get_configuration_options"
  | "ptz.continuous_move"
  | "ptz.relative_move"
  | "ptz.absolute_move"
  | "ptz.stop"
  | "ptz.goto_preset"
  | "ptz.set_preset"
  | "ptz.remove_preset"
  | "ptz.goto_home"
  | "ptz.set_home"
  | "ptz.send_auxiliary_command"
  | "deviceio.set_relay_output_state"
  | "imaging.get_settings"
  | "imaging.get_options"
  | "media.get_profiles"
  | "media.get_stream_uri"
  | "media.get_snapshot_uri";

export interface OnvifActionRequest {
  action: OnvifActionName;
  params?: Record<string, unknown>;
}

export interface OnvifActionError {
  code:
    | "invalid_params"
    | "unsupported_action"
    | "unsupported_capability"
    | "auth_failed"
    | "soap_fault"
    | "camera_unreachable"
    | "timeout";
  message: string;
  details?: Record<string, unknown>;
}

export interface OnvifActionResult {
  status: "ok";
  action: OnvifActionName;
  data?: Record<string, unknown>;
  rawXml?: string;
}

export class OnvifActionException extends Error {
  readonly error: OnvifActionError;

  constructor(error: OnvifActionError) {
    super(error.message);
    this.name = "OnvifActionException";
    this.error = error;
  }
}

interface ProfileSummary {
  token: string;
  name: string | null;
  ptzConfigurationToken: string | null;
}


type WssePasswordMode = "digest" | "text";

function wsseHeader(username: string, password: string, mode: WssePasswordMode = "digest"): string {
  let passwordXml: string;
  let extraXml = "";
  if (mode === "digest") {
    // WS-Security UsernameToken with PasswordDigest (the ONVIF-standard form).
    // PasswordDigest = Base64( SHA1( nonce + created + password ) )
    const nonceRaw = randomBytes(16);
    const nonce = nonceRaw.toString("base64");
    const created = new Date().toISOString();
    const digest = createHash("sha1")
      .update(Buffer.concat([nonceRaw, Buffer.from(created, "utf8"), Buffer.from(password, "utf8")]))
      .digest("base64");
    passwordXml = `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`;
    extraXml = `
          <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</Nonce>
          <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`;
  } else {
    passwordXml = `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(password)}</Password>`;
  }
  return `
    <s:Header>
      <Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
        <UsernameToken>
          <Username>${escapeXml(username)}</Username>
          ${passwordXml}${extraXml}
        </UsernameToken>
      </Security>
    </s:Header>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractSoapFault(xml: string): string | null {
  if (!/<(?:[\w-]+:)?Fault\b/.test(xml)) return null;

  const reason = pickAll(xml, "Text")[0] ?? pickAll(xml, "faultstring")[0] ?? "";
  const subcode = pickAll(xml, "Subcode")[0] ?? "";
  const value = pickAll(xml, "Value")[0] ?? "";

  const parts = [reason, subcode, value]
    .map((part) => part.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (parts.length > 0) return parts.join(" | ").slice(0, 300);
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "unknown SOAP fault";
}

async function soap(
  url: string,
  action: string,
  bodyXml: string,
  timeoutMs: number,
  transport?: SoapTransport,
  username?: string,
  password?: string,
  extraNamespaces?: string,
): Promise<string> {
  const envelopes = buildAuthEnvelopes(username ?? "", password ?? "", bodyXml, extraNamespaces);

  if (transport) {
    const errors: string[] = [];
    for (const envelope of envelopes) {
      try {
        const text = await transport(url, action, envelope.body, timeoutMs, username, password);
        const fault = extractSoapFault(text);
        if (!fault) return text;
        errors.push(`[${envelope.kind}] SOAP fault: ${fault} | response body: ${text.slice(0, 800)}`);
      } catch (err) {
        errors.push(`[${envelope.kind}] ${(err as Error).message}`);
      }
    }
    throw new Error(`ONVIF ${action} failed all auth methods:\n${errors.join("\n")}`);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let digestChallenge: string | null = null;
    const errors: string[] = [];

    for (const envelope of envelopes) {
      const attempts = envelope.kind === "no-wsse" && username
        ? [
            { kind: "basic", auth: `Basic ${Buffer.from(`${username}:${password ?? ""}`, "utf8").toString("base64")}` },
            { kind: "challenge", auth: "" },
          ]
        : [{ kind: envelope.kind, auth: "" }];

      for (const attempt of attempts) {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": `application/soap+xml; charset=utf-8; action="${action}"`,
            "SOAPAction": action,
            ...(attempt.auth ? { Authorization: attempt.auth } : {}),
          },
          body: envelope.body,
          signal: controller.signal,
        });
        const text = await res.text();
        if (!digestChallenge) {
          digestChallenge = res.headers.get("www-authenticate");
        }
        const fault = extractSoapFault(text);
        if (res.ok && !fault) {
          return text;
        }
        errors.push(fault
          ? `[${envelope.kind}/${attempt.kind}] SOAP fault: ${fault} | response body: ${text.slice(0, 800)}`
          : `[${envelope.kind}/${attempt.kind}] HTTP ${String(res.status)}: ${text.slice(0, 800)}`);
      }

      if (envelope.kind === "no-wsse" && username && digestChallenge?.toLowerCase().includes("digest")) {
        const digestAuth = buildDigestAuthHeader("POST", url, digestChallenge, username, password ?? "");
        if (digestAuth) {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": `application/soap+xml; charset=utf-8; action="${action}"`,
              "SOAPAction": action,
              Authorization: digestAuth,
            },
            body: envelope.body,
            signal: controller.signal,
          });
          const text = await res.text();
          const fault = extractSoapFault(text);
          if (res.ok && !fault) {
            return text;
          }
          errors.push(fault
            ? `[digest] SOAP fault: ${fault} | response body: ${text.slice(0, 800)}`
            : `[digest] HTTP ${String(res.status)}: ${text.slice(0, 800)}`);
        }
      }
    }
    throw new Error(`ONVIF ${action} failed all auth methods:\n${errors.join("\n")}`);
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
  username?: string,
  password?: string,
): Promise<string | null> {
  try {
    return await soap(url, action, body, timeoutMs, transport, username, password);
  } catch {
    return null;
  }
}

function parseDigestChallenge(header: string): Record<string, string> | null {
  if (!header.toLowerCase().startsWith("digest ")) return null;
  const values: Record<string, string> = {};
  for (const part of header.slice(7).split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const raw = part.slice(idx + 1).trim();
    values[key] = raw.replace(/^"|"$/g, "");
  }
  return values;
}

function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

function buildDigestAuthHeader(method: string, url: string, challengeHeader: string, username: string, password: string): string | null {
  const params = parseDigestChallenge(challengeHeader);
  if (!params?.realm || !params.nonce) return null;
  const parsed = new URL(url);
  const uri = `${parsed.pathname}${parsed.search}`;
  const qop = params.qop?.split(",").map((v) => v.trim()).find((v) => v === "auth") ?? "";
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = md5Hex(`${username}:${params.realm}:${password}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const response = qop
    ? md5Hex(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5Hex(`${ha1}:${params.nonce}:${ha2}`);
  const parts = [
    `Digest username="${username}"`,
    `realm="${params.realm}"`,
    `nonce="${params.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (params.opaque) parts.push(`opaque="${params.opaque}"`);
  if (params.algorithm) parts.push(`algorithm=${params.algorithm}`);
  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }
  return parts.join(", ");
}

function buildEnvelope(headerXml: string, bodyXml: string, extraNamespaces?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema"
  ${extraNamespaces ?? ""}>
  ${headerXml}
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

function buildAuthEnvelopes(username: string, password: string, bodyXml: string, extraNamespaces?: string): Array<{ kind: string; body: string }> {
  if (!username) return [{ kind: "no-wsse", body: buildEnvelope("", bodyXml, extraNamespaces) }];
  return [
    { kind: "wsse-digest", body: buildEnvelope(wsseHeader(username, password, "digest"), bodyXml, extraNamespaces) },
    { kind: "wsse-text", body: buildEnvelope(wsseHeader(username, password, "text"), bodyXml, extraNamespaces) },
    { kind: "no-wsse", body: buildEnvelope("", bodyXml, extraNamespaces) },
  ];
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

function previewXml(xml: string): string {
  return xml.replace(/\s+/g, " ").trim().slice(0, 400);
}

function onvifError(
  code: OnvifActionError["code"],
  message: string,
  details?: Record<string, unknown>,
): OnvifActionException {
  return new OnvifActionException({ code, message, details });
}

function classifySoapError(err: unknown): OnvifActionException {
  if (err instanceof OnvifActionException) return err;
  const message = err instanceof Error ? err.message : String(err);
  const details: Record<string, unknown> = {};
  const lower = message.toLowerCase();
  const xmlStart = message.indexOf("<?xml");
  if (xmlStart >= 0) details.responsePreview = message.slice(xmlStart, xmlStart + 400);
  if (lower.includes("soap fault")) {
    return onvifError("soap_fault", message, details);
  }
  if (lower.includes("unauthorized") || lower.includes("invalidsecurity") || lower.includes("invalidtoken")) {
    return onvifError("auth_failed", message, details);
  }
  if (lower.includes("timed out")) {
    return onvifError("timeout", message, details);
  }
  return onvifError("camera_unreachable", message, details);
}

function pathLooksLikeMediaService(path: string): boolean {
  return /\/(?:onvif\/)?(?:media_service|media)(?:\/)?$/i.test(path);
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
      deviceUrl: path && !pathLooksLikeMediaService(path) ? `${origin}${path}` : `${origin}/onvif/device_service`,
      explicitMediaUrl: path && pathLooksLikeMediaService(path) ? `${origin}${path}` : null,
    };
  }

  const origin = `http://${raw}:${String(port)}`;
  return {
    origin,
    deviceUrl: `${origin}/onvif/device_service`,
    explicitMediaUrl: null,
  };
}

async function discoverServices(
  input: DiscoverInput,
  endpoint: EndpointParts,
  timeoutMs: number,
  transport?: SoapTransport,
): Promise<ServiceAddresses> {
  if (input.mediaPath) {
    return {
      mediaUrl: `${endpoint.origin}${input.mediaPath.startsWith("/") ? input.mediaPath : `/${input.mediaPath}`}`,
      eventUrl: `${endpoint.origin}/onvif/event_service`,
      ptzUrl: null,
      imagingUrl: null,
      deviceIoUrl: null,
      capabilitiesXml: null,
    };
  }

  if (endpoint.explicitMediaUrl) {
    return {
      mediaUrl: endpoint.explicitMediaUrl,
      eventUrl: `${endpoint.origin}/onvif/event_service`,
      ptzUrl: null,
      imagingUrl: null,
      deviceIoUrl: null,
      capabilitiesXml: null,
    };
  }

  const capabilitiesXml = await trySoap(
    endpoint.deviceUrl,
    "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
    `<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>All</tds:Category></tds:GetCapabilities>`,
    timeoutMs,
    transport,
    input.username,
    input.password,
  );
  return {
    mediaUrl: pickFirstXAddr(capabilitiesXml ?? "", "Media")
      // Common vendor endpoints. Prefer lower-case media_service because many NVRs
      // advertise that path and return 404 for /onvif/Media.
      ?? `${endpoint.origin}/onvif/media_service`,
    eventUrl: pickFirstXAddr(capabilitiesXml ?? "", "Events")
      ?? `${endpoint.origin}/onvif/event_service`,
    ptzUrl: pickFirstXAddr(capabilitiesXml ?? "", "PTZ"),
    imagingUrl: pickFirstXAddr(capabilitiesXml ?? "", "Imaging"),
    deviceIoUrl: pickFirstXAddr(capabilitiesXml ?? "", "DeviceIO"),
    capabilitiesXml,
  };
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
export interface DiscoverResult {
  cameras: DiscoveredCamera[];
  debug: {
    mediaUrl: string;
    deviceName: string | null;
    profileCount: number;
    rawProfilesXml: string;
    rawCapabilitiesXml: string | null;
  };
}

export async function discover(input: DiscoverInput): Promise<DiscoverResult> {
  const timeoutMs = input.timeoutMs ?? 8000;
  const endpoint = normalizeEndpoint(input);
  const services = await discoverServices(input, endpoint, timeoutMs, input.soapTransport);
  const mediaUrl = services.mediaUrl;

  // ---- GetDeviceInformation (best-effort, for friendly device name) ---------
  let deviceName: string | null = null;
  try {
    const devInfoXml = await soap(
      endpoint.deviceUrl,
      "http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation",
      `<tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>`,
      timeoutMs,
      input.soapTransport,
      input.username,
      input.password,
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
  const profilesXml = await soap(
    mediaUrl,
    "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
    `<trt:GetProfiles/>`,
    timeoutMs,
    input.soapTransport,
    input.username,
    input.password,
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
    let streamXml: string;
    try {
      streamXml = await soap(
        mediaUrl,
        "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
        streamBody,
        timeoutMs,
        input.soapTransport,
        input.username,
        input.password,
      );
    } catch {
      continue; // skip profiles we can't get a stream uri for
    }
    const uri = pickAll(streamXml, "Uri")[0] ?? "";
    if (!uri) continue;
    const snapshotBody = `<trt:GetSnapshotUri>
      <trt:ProfileToken>${escapeXml(token)}</trt:ProfileToken>
    </trt:GetSnapshotUri>`;
    let snapshotUri: string | null = null;
    try {
      const snapshotXml = await soap(
        mediaUrl,
        "http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri",
        snapshotBody,
        timeoutMs,
        input.soapTransport,
        input.username,
        input.password,
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

  const cameras = groupProfiles(input.host, deviceName, out);
  return {
    cameras,
    debug: {
      mediaUrl,
      deviceName,
      profileCount: profileBlocks.length,
      rawProfilesXml: profilesXml,
      rawCapabilitiesXml: services.capabilitiesXml,
    },
  };
}


async function getProfileSummaries(
  input: DiscoverInput,
  timeoutMs: number,
  mediaUrl: string,
): Promise<ProfileSummary[]> {
  const xml = await soap(
    mediaUrl,
    "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
    "<trt:GetProfiles/>",
    timeoutMs,
    input.soapTransport,
    input.username,
    input.password,
  );
  const blocks = splitProfiles(xml);
  const tokens = pickAttr(xml, "Profiles", "token");
  return blocks.map((block, idx) => ({
    token: tokens[idx] ?? "",
    name: pickNested(block, "Name"),
    ptzConfigurationToken: pickAttr(block, "PTZConfiguration", "token")[0] ?? null,
  })).filter((profile) => profile.token);
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readNumber(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(params: Record<string, unknown>, key: string): boolean | null {
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return null;
}

function requireProfileToken(
  action: OnvifActionName,
  params: Record<string, unknown>,
  profiles: ProfileSummary[],
): string {
  const explicit = readString(params, "profileToken");
  if (explicit) return explicit;
  if (profiles.length === 1) return profiles[0]!.token;
  throw onvifError("invalid_params", `${action} requires profileToken when multiple profiles exist`, {
    availableProfileTokens: profiles.map((profile) => profile.token),
  });
}

function requirePtzConfigurationToken(profileToken: string, profiles: ProfileSummary[]): string {
  const profile = profiles.find((entry) => entry.token === profileToken);
  if (!profile?.ptzConfigurationToken) {
    throw onvifError("unsupported_capability", `Profile ${profileToken} does not expose PTZ configuration`);
  }
  return profile.ptzConfigurationToken;
}

function resolveServiceUrl(serviceUrl: string | null, action: OnvifActionName): string {
  if (!serviceUrl) {
    throw onvifError("unsupported_capability", `${action} is not supported by this device`);
  }
  return serviceUrl;
}

async function execActionSoap(
  input: DiscoverInput,
  timeoutMs: number,
  url: string,
  action: string,
  bodyXml: string,
  extraNamespaces?: string,
): Promise<string> {
  try {
    return await soap(url, action, bodyXml, timeoutMs, input.soapTransport, input.username, input.password, extraNamespaces);
  } catch (err) {
    throw classifySoapError(err);
  }
}

function result(action: OnvifActionName, xml: string, data?: Record<string, unknown>): OnvifActionResult {
  return {
    status: "ok",
    action,
    data,
    rawXml: previewXml(xml),
  };
}

export async function performAction(
  input: DiscoverInput & OnvifActionRequest,
): Promise<OnvifActionResult> {
  const timeoutMs = input.timeoutMs ?? 8000;
  const endpoint = normalizeEndpoint(input);
  const services = await discoverServices(input, endpoint, timeoutMs, input.soapTransport);
  const params = asRecord(input.params);
  const action = input.action;

  const needsProfiles = new Set<OnvifActionName>([
    "ptz.get_status",
    "ptz.get_configuration_options",
    "ptz.continuous_move",
    "ptz.relative_move",
    "ptz.absolute_move",
    "ptz.stop",
    "ptz.goto_preset",
    "ptz.set_preset",
    "ptz.remove_preset",
    "ptz.goto_home",
    "ptz.set_home",
    "ptz.send_auxiliary_command",
    "media.get_stream_uri",
    "media.get_snapshot_uri",
  ]);
  const profiles = needsProfiles.has(action) || action === "media.get_profiles"
    ? await getProfileSummaries(input, timeoutMs, services.mediaUrl)
    : [];

  if (action === "media.get_profiles") {
    return result(action, JSON.stringify(profiles), {
      profiles: profiles.map((profile) => ({
        token: profile.token,
        name: profile.name,
        ptzConfigurationToken: profile.ptzConfigurationToken,
      })),
    });
  }

  if (action === "media.get_stream_uri" || action === "media.get_snapshot_uri") {
    const profileToken = requireProfileToken(action, params, profiles);
    const body = action === "media.get_stream_uri"
      ? `<trt:GetStreamUri>
          <trt:StreamSetup>
            <tt:Stream>RTP-Unicast</tt:Stream>
            <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
          </trt:StreamSetup>
          <trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken>
        </trt:GetStreamUri>`
      : `<trt:GetSnapshotUri><trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetSnapshotUri>`;
    const soapAction = action === "media.get_stream_uri"
      ? "http://www.onvif.org/ver10/media/wsdl/GetStreamUri"
      : "http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri";
    const xml = await execActionSoap(input, timeoutMs, services.mediaUrl, soapAction, body);
    const uri = pickAll(xml, "Uri")[0] ?? null;
    return result(action, xml, { profileToken, uri });
  }

  if (action.startsWith("ptz.")) {
    const ptzUrl = resolveServiceUrl(services.ptzUrl, action);
    if (action === "ptz.get_nodes") {
      const xml = await execActionSoap(
        input,
        timeoutMs,
        ptzUrl,
        "http://www.onvif.org/ver20/ptz/wsdl/GetNodes",
        "<tptz:GetNodes/>",
        `xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"`,
      );
      return result(action, xml, { nodes: pickAttr(xml, "PTZNode", "token") });
    }

    const profileToken = requireProfileToken(action, params, profiles);
    const speedPan = readNumber(params, "pan");
    const speedTilt = readNumber(params, "tilt");
    const speedZoom = readNumber(params, "zoom");
    const timeoutText = readString(params, "timeout") ?? (() => {
      const timeoutMsValue = readNumber(params, "timeoutMs");
      return timeoutMsValue != null ? `PT${Math.max(timeoutMsValue, 1) / 1000}S` : null;
    })();

    if (action === "ptz.get_status") {
      const xml = await execActionSoap(
        input,
        timeoutMs,
        ptzUrl,
        "http://www.onvif.org/ver20/ptz/wsdl/GetStatus",
        `<tptz:GetStatus><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:GetStatus>`,
        `xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"`,
      );
      return result(action, xml, {
        profileToken,
        pan: readNumber({ value: pickAttr(xml, "PanTilt", "x")[0] ?? null }, "value"),
        tilt: readNumber({ value: pickAttr(xml, "PanTilt", "y")[0] ?? null }, "value"),
        zoom: readNumber({ value: pickAttr(xml, "Zoom", "x")[0] ?? null }, "value"),
      });
    }

    if (action === "ptz.get_configuration_options") {
      const configurationToken = requirePtzConfigurationToken(profileToken, profiles);
      const xml = await execActionSoap(
        input,
        timeoutMs,
        ptzUrl,
        "http://www.onvif.org/ver20/ptz/wsdl/GetConfigurationOptions",
        `<tptz:GetConfigurationOptions><tptz:ConfigurationToken>${escapeXml(configurationToken)}</tptz:ConfigurationToken></tptz:GetConfigurationOptions>`,
        `xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"`,
      );
      return result(action, xml, { profileToken, configurationToken });
    }

    let body = "";
    let soapAction = "";
    if (action === "ptz.continuous_move") {
      body = `<tptz:ContinuousMove>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        <tptz:Velocity>
          <tt:PanTilt x="${String(speedPan ?? 0)}" y="${String(speedTilt ?? 0)}"/>
          <tt:Zoom x="${String(speedZoom ?? 0)}"/>
        </tptz:Velocity>
        ${timeoutText ? `<tptz:Timeout>${escapeXml(timeoutText)}</tptz:Timeout>` : ""}
      </tptz:ContinuousMove>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove";
    } else if (action === "ptz.relative_move") {
      const x = readNumber(params, "x");
      const y = readNumber(params, "y");
      const z = readNumber(params, "z");
      if (x == null && y == null && z == null) {
        throw onvifError("invalid_params", "ptz.relative_move requires x, y, or z");
      }
      body = `<tptz:RelativeMove>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        <tptz:Translation>
          <tt:PanTilt x="${String(x ?? 0)}" y="${String(y ?? 0)}"/>
          <tt:Zoom x="${String(z ?? 0)}"/>
        </tptz:Translation>
        <tptz:Speed>
          <tt:PanTilt x="${String(speedPan ?? 0)}" y="${String(speedTilt ?? 0)}"/>
          <tt:Zoom x="${String(speedZoom ?? 0)}"/>
        </tptz:Speed>
      </tptz:RelativeMove>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/RelativeMove";
    } else if (action === "ptz.absolute_move") {
      const x = readNumber(params, "x");
      const y = readNumber(params, "y");
      const z = readNumber(params, "z");
      if (x == null && y == null && z == null) {
        throw onvifError("invalid_params", "ptz.absolute_move requires x, y, or z");
      }
      body = `<tptz:AbsoluteMove>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        <tptz:Position>
          <tt:PanTilt x="${String(x ?? 0)}" y="${String(y ?? 0)}"/>
          <tt:Zoom x="${String(z ?? 0)}"/>
        </tptz:Position>
        <tptz:Speed>
          <tt:PanTilt x="${String(speedPan ?? 0)}" y="${String(speedTilt ?? 0)}"/>
          <tt:Zoom x="${String(speedZoom ?? 0)}"/>
        </tptz:Speed>
      </tptz:AbsoluteMove>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/AbsoluteMove";
    } else if (action === "ptz.stop") {
      const panTilt = readBoolean(params, "panTilt");
      const zoom = readBoolean(params, "zoom");
      body = `<tptz:Stop>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        <tptz:PanTilt>${String(panTilt ?? true)}</tptz:PanTilt>
        <tptz:Zoom>${String(zoom ?? true)}</tptz:Zoom>
      </tptz:Stop>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/Stop";
    } else if (action === "ptz.goto_preset") {
      const presetToken = readString(params, "presetToken");
      if (!presetToken) throw onvifError("invalid_params", "ptz.goto_preset requires presetToken");
      body = `<tptz:GotoPreset>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        <tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>
      </tptz:GotoPreset>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/GotoPreset";
    } else if (action === "ptz.set_preset") {
      const presetName = readString(params, "presetName");
      const presetToken = readString(params, "presetToken");
      body = `<tptz:SetPreset>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        ${presetName ? `<tptz:PresetName>${escapeXml(presetName)}</tptz:PresetName>` : ""}
        ${presetToken ? `<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>` : ""}
      </tptz:SetPreset>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/SetPreset";
    } else if (action === "ptz.remove_preset") {
      const presetToken = readString(params, "presetToken");
      if (!presetToken) throw onvifError("invalid_params", "ptz.remove_preset requires presetToken");
      body = `<tptz:RemovePreset>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        <tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>
      </tptz:RemovePreset>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/RemovePreset";
    } else if (action === "ptz.goto_home") {
      body = `<tptz:GotoHomePosition><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:GotoHomePosition>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/GotoHomePosition";
    } else if (action === "ptz.set_home") {
      body = `<tptz:SetHomePosition><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:SetHomePosition>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/SetHomePosition";
    } else if (action === "ptz.send_auxiliary_command") {
      const auxiliaryData = readString(params, "auxiliaryData");
      if (!auxiliaryData) throw onvifError("invalid_params", "ptz.send_auxiliary_command requires auxiliaryData");
      body = `<tptz:SendAuxiliaryCommand>
        <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
        <tptz:AuxiliaryData>${escapeXml(auxiliaryData)}</tptz:AuxiliaryData>
      </tptz:SendAuxiliaryCommand>`;
      soapAction = "http://www.onvif.org/ver20/ptz/wsdl/SendAuxiliaryCommand";
    } else {
      throw onvifError("unsupported_action", `Unsupported ONVIF action: ${action}`);
    }

    const xml = await execActionSoap(
      input,
      timeoutMs,
      ptzUrl,
      soapAction,
      body,
      `xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"`,
    );
    return result(action, xml, { profileToken });
  }

  if (action === "deviceio.set_relay_output_state") {
    const deviceIoUrl = resolveServiceUrl(services.deviceIoUrl, action);
    const relayToken = readString(params, "relayToken");
    const logicalState = readString(params, "logicalState");
    if (!relayToken || !logicalState) {
      throw onvifError("invalid_params", "deviceio.set_relay_output_state requires relayToken and logicalState");
    }
    const xml = await execActionSoap(
      input,
      timeoutMs,
      deviceIoUrl,
      "http://www.onvif.org/ver10/deviceIO/wsdl/SetRelayOutputState",
      `<tmd:SetRelayOutputState>
          <tmd:RelayOutputToken>${escapeXml(relayToken)}</tmd:RelayOutputToken>
          <tmd:LogicalState>${escapeXml(logicalState)}</tmd:LogicalState>
        </tmd:SetRelayOutputState>`,
      `xmlns:tmd="http://www.onvif.org/ver10/deviceIO/wsdl"`,
    );
    return result(action, xml, { relayToken, logicalState });
  }

  if (action === "imaging.get_settings" || action === "imaging.get_options") {
    const imagingUrl = resolveServiceUrl(services.imagingUrl, action);
    const videoSourceToken = readString(params, "videoSourceToken")
      ?? (() => {
        const sourceToken = pickAll(services.capabilitiesXml ?? "", "SourceToken")[0];
        return sourceToken || null;
      })();
    if (!videoSourceToken) {
      throw onvifError("invalid_params", `${action} requires videoSourceToken`);
    }
    const soapAction = action === "imaging.get_settings"
      ? "http://www.onvif.org/ver20/imaging/wsdl/GetImagingSettings"
      : "http://www.onvif.org/ver20/imaging/wsdl/GetOptions";
    const body = action === "imaging.get_settings"
      ? `<timg:GetImagingSettings><timg:VideoSourceToken>${escapeXml(videoSourceToken)}</timg:VideoSourceToken></timg:GetImagingSettings>`
      : `<timg:GetOptions><timg:VideoSourceToken>${escapeXml(videoSourceToken)}</timg:VideoSourceToken></timg:GetOptions>`;
    const xml = await execActionSoap(
      input,
      timeoutMs,
      imagingUrl,
      soapAction,
      body,
      `xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl"`,
    );
    return result(action, xml, { videoSourceToken });
  }

  throw onvifError("unsupported_action", `Unsupported ONVIF action: ${action}`);
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
  const services = await discoverServices(input, endpoint, timeoutMs, input.soapTransport);
  const eventUrl = services.eventUrl;

  let xml: string;
  try {
    xml = await soap(eventUrl,
      "http://www.onvif.org/ver10/events/wsdl/EventPortType/GetEventPropertiesRequest",
      `<tev:GetEventProperties xmlns:tev="http://www.onvif.org/ver10/events/wsdl"/>`,
      timeoutMs,
      input.soapTransport,
      input.username,
      input.password);
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
