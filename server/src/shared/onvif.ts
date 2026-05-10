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
  encoding: string | null;
  width: number | null;
  height: number | null;
  framerate: number | null;
  stream_uri: string;
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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function soap(url: string, action: string, body: string, timeoutMs: number): Promise<string> {
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
  } finally {
    clearTimeout(t);
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

/**
 * Connect to an ONVIF camera and list its media profiles with their
 * resolutions, encodings, and RTSP stream URIs.
 *
 * Throws on transport error. Profile fields default to null if the camera
 * omits them.
 */
export async function discover(input: DiscoverInput): Promise<DiscoveredProfile[]> {
  const host = input.host;
  const port = input.port || 80;
  const mediaPath = input.mediaPath ?? "/onvif/Media";
  const mediaUrl = `http://${host}:${String(port)}${mediaPath}`;
  const timeoutMs = input.timeoutMs ?? 8000;

  const header = wsseHeader(input.username, input.password);

  // ---- GetProfiles -----------------------------------------------------------
  const profilesEnv = buildEnvelope(header, `<trt:GetProfiles/>`);
  const profilesXml = await soap(
    mediaUrl,
    "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
    profilesEnv,
    timeoutMs,
  );

  const profileBlocks = splitProfiles(profilesXml);
  const tokenAttrs = pickAttr(profilesXml, "Profiles", "token");

  const out: DiscoveredProfile[] = [];
  for (let i = 0; i < profileBlocks.length; i += 1) {
    const block = profileBlocks[i] ?? "";
    const token = tokenAttrs[i] ?? "";
    const profileName = pickNested(block, "Name") ?? token ?? `profile_${String(i)}`;

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
      );
    } catch {
      continue; // skip profiles we can't get a stream uri for
    }
    const uri = pickAll(streamXml, "Uri")[0] ?? "";
    if (!uri) continue;

    out.push({
      profile_name: profileName,
      profile_token: token,
      encoding,
      width,
      height,
      framerate,
      stream_uri: uri,
    });
  }

  return out;
}
