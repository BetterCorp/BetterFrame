import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { Repository } from "./db/repository.js";
import type { SecretsApi } from "./secrets.js";
import { simpleVmsAddress } from "./simple-vms-schema.js";
import { getSimpleVmsSource, simpleVmsTokenHash, reconcileSimpleVmsAssignments, refreshSimpleVmsKioskEnabled, lockSimpleVmsKiosks, type SimpleVmsSource } from "./simple-vms.js";

const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const proof = /^[A-Za-z0-9_-]{43}$/;
export function simpleVmsPairReturn(value: string | undefined): string | null {
  if (!value || value.length > 8192 || !value.startsWith("/admin/simplevms/pair?") || /[\\\r\n]/.test(value)) return null;
  const url = new URL(value, "http://pair.local");
  return url.origin === "http://pair.local" && url.pathname === "/admin/simplevms/pair" && !url.hash ? url.pathname + url.search : null;
}
export function packSimpleVmsPairReturn(value: string): string {
  if (!simpleVmsPairReturn(value)) throw new Error("Invalid pairing continuation");
  const encoded = deflateRawSync(Buffer.from(value)).toString("base64url");
  if (encoded.length > 3800) throw new Error("Pairing link is too long");
  return encoded;
}
export function unpackSimpleVmsPairReturn(value: string | undefined): string | null {
  if (!value || value.length > 3800 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try { return simpleVmsPairReturn(inflateRawSync(Buffer.from(value, "base64url"), { maxOutputLength: 8192 }).toString("utf8")); }
  catch { return null; }
}
export interface SimpleVmsPairRequest extends Record<string, string> {
  instance_id: string; name: string; redirect_uri: string; state: string; challenge: string;
  local_address: string; external_address: string; local_http_address: string; external_http_address: string;
}
export interface SimpleVmsPairGrant {
  instanceId: string; sourceId: string; name: string; callbackUrl: string; managementUrl: string;
  integrationToken: string; viewerUsername: string; viewerPassword: string;
  localAddress: string; externalAddress: string; localHttpAddress: string; externalHttpAddress: string;
}
export function simpleVmsAuthority(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS BetterFrame URL");
  return url;
}
export function simpleVmsBrowserAddress(value: string): string {
  if (!value) return "";
  const url = simpleVmsAuthority(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Use a browser media address without a path");
  return url.origin;
}
export function validateSimpleVmsPairRequest(input: Record<string, unknown>): SimpleVmsPairRequest {
  const get = (key: string) => typeof input[key] === "string" ? input[key] as string : "";
  const instance = get("instance_id"); const name = get("name").trim();
  if (!instance || instance.length > 128 || !name || name.length > 255 || !proof.test(get("state")) || !proof.test(get("challenge"))) throw new Error("Invalid or incomplete SimpleVMS pairing request");
  const redirect = new URL(get("redirect_uri"));
  if (!["https:", "http:"].includes(redirect.protocol) || redirect.username || redirect.password || redirect.search || redirect.hash
    || redirect.pathname !== "/betterframe-pairing-return" || ["0.0.0.0", "[::]"].includes(redirect.hostname)) throw new Error("Invalid SimpleVMS return address");
  return { instance_id: instance, name, redirect_uri: redirect.href, state: get("state"), challenge: get("challenge"),
    local_address: simpleVmsAddress(get("local_address")), external_address: get("external_address") ? simpleVmsAddress(get("external_address"), true) : "",
    local_http_address: simpleVmsBrowserAddress(get("local_http_address")), external_http_address: simpleVmsBrowserAddress(get("external_http_address")) };
}

/** Only an authenticated BF administrator approves a pairing. No long-lived credentials enter redirects. */
export async function approveSimpleVmsPairing(repo: Repository, secrets: SecretsApi, request: SimpleVmsPairRequest, tenantSlug: string, frameUrl: string): Promise<string> {
  request = validateSimpleVmsPairRequest(request as unknown as Record<string, unknown>);
  const frame = simpleVmsAuthority(frameUrl);
  const existing = await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE instance_id = ?", [request.instance_id]);
  const id = existing?.id ?? uuidv7();
  const grant: SimpleVmsPairGrant = { instanceId: request.instance_id, sourceId: id, name: request.name,
    callbackUrl: new URL(`/api/simplevms/${encodeURIComponent(tenantSlug)}/${id}/events`, frame).href,
    managementUrl: new URL(`/simplevms/instance/${id}`, frame).href,
    integrationToken: secret(), viewerUsername: `bf-${randomBytes(12).toString("hex")}`, viewerPassword: secret(),
    localAddress: request.local_address, externalAddress: request.external_address,
    localHttpAddress: request.local_http_address, externalHttpAddress: request.external_http_address };
  const code = secret();
  await repo.adapter.run("DELETE FROM simple_vms_pairings WHERE expires_at < now()", []);
  await repo.adapter.run(`INSERT INTO simple_vms_pairings(code_hash, challenge, instance_id, grant_encrypted, expires_at)
    VALUES (?, ?, ?, ?, now() + interval '10 minutes')`, [simpleVmsTokenHash(code), request.challenge, request.instance_id,
    secrets.encryptString(JSON.stringify(grant), "simple-vms-pairing")]);
  const redirect = new URL(request.redirect_uri);
  redirect.hash = new URLSearchParams({ bf_pair_code: code, bf_pair_state: request.state, bf_pair_tenant: tenantSlug }).toString();
  return redirect.href;
}

/** PKCE binds redemption to the recorder that started the browser flow. */
export async function claimSimpleVmsPairing(repo: Repository, secrets: SecretsApi, input: { code: string; verifier: string; instanceId: string }): Promise<SimpleVmsPairGrant> {
  if (!proof.test(input.code) || !proof.test(input.verifier) || !input.instanceId || input.instanceId.length > 128) throw new Error("Invalid pairing proof");
  return repo.transact(async () => {
    const pending = await repo.adapter.get<{ challenge: string; instance_id: string; grant_encrypted: string; expires_at: string; claimed_at: string | null }>(
      "SELECT * FROM simple_vms_pairings WHERE code_hash = ? FOR UPDATE", [simpleVmsTokenHash(input.code)]);
    if (!pending || pending.claimed_at || new Date(pending.expires_at).getTime() <= Date.now() || pending.instance_id !== input.instanceId) throw new Error("Pairing expired or already used; pair again from SimpleVMS");
    const expected = Buffer.from(pending.challenge); const actual = Buffer.from(digest(input.verifier));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("Invalid pairing proof");
    const grant = JSON.parse(secrets.decryptString(pending.grant_encrypted, "simple-vms-pairing")) as SimpleVmsPairGrant;
    await repo.adapter.get("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`simplevms-pair:${input.instanceId}`]);
    const previous = await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE instance_id = ? FOR UPDATE", [input.instanceId]);
    if (previous && previous.id !== grant.sourceId) throw new Error("This recorder was paired by another request; pair again");
    const deviceId = previous?.device_id ?? uuidv7();
    if (!previous) await repo.adapter.run(`INSERT INTO camera_devices(id, name, type, host, port, discovery_runner)
      VALUES (?, ?, 'simplevms', ?, ?, 'server')`, [deviceId, grant.name, new URL(grant.externalAddress || grant.localAddress).hostname,
      Number(new URL(grant.externalAddress || grant.localAddress).port || 554)]);
    await repo.adapter.run(`INSERT INTO simple_vms_sources(id, instance_id, device_id, enabled, auto_sync, local_address, external_address,
      local_http_address, external_http_address, viewer_username, viewer_password_encrypted, ingest_key_hash)
      VALUES (?, ?, ?, true, true, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = true, auto_sync = true, local_address = excluded.local_address, external_address = excluded.external_address,
      local_http_address = excluded.local_http_address, external_http_address = excluded.external_http_address,
      viewer_username = excluded.viewer_username, viewer_password_encrypted = excluded.viewer_password_encrypted, ingest_key_hash = excluded.ingest_key_hash`,
    [grant.sourceId, input.instanceId, deviceId, grant.localAddress, grant.externalAddress || null, grant.localHttpAddress || null,
      grant.externalHttpAddress || null, grant.viewerUsername, secrets.encryptString(grant.viewerPassword, "simple-vms-viewer"), simpleVmsTokenHash(grant.integrationToken)]);
    await repo.adapter.run("UPDATE simple_vms_pairings SET claimed_at = now() WHERE code_hash = ?", [simpleVmsTokenHash(input.code)]);
    await lockSimpleVmsKiosks(repo, grant.sourceId);
    const linked = await repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [grant.sourceId]);
    for (const id of [previous?.owner_kiosk_id, ...linked.map(k => k.kiosk_id)].filter((id): id is string => !!id)) await refreshSimpleVmsKioskEnabled(repo, id);
    await reconcileSimpleVmsAssignments(repo, grant.sourceId);
    if (!await getSimpleVmsSource(repo, grant.sourceId)) throw new Error("Pairing could not be completed");
    return grant;
  });
}
