import * as av from "anyvali";

const externalId = av.string().minLength(1).maxLength(128);
const profile = av.object({
  id: externalId, name: av.string().minLength(1).maxLength(255),
  role: av.enum_(["main", "sub", "other"] as const),
  codec: av.string().maxLength(32), width: av.int().min(0).max(32768), height: av.int().min(0).max(32768),
  fps: av.number().min(0).max(1000),
}, { unknownKeys: "reject" });

// Full, revisioned catalog envelopes make retries and reconciliation atomic.
// They are sent on changes, never requested by a periodic catalog poll.
export const SimpleVmsSnapshot = av.object({
  version: av.literal(1), instanceId: externalId, revision: av.int().min(1).max(Number.MAX_SAFE_INTEGER),
  name: av.string().minLength(1).maxLength(255),
  cameras: av.array(av.object({
    id: externalId, name: av.string().minLength(1).maxLength(255),
    enabled: av.bool(), profiles: av.array(profile).maxItems(32),
  }, { unknownKeys: "reject" })).maxItems(4096),
  groups: av.array(av.object({
    id: externalId, name: av.string().minLength(1).maxLength(255),
    cameraIds: av.array(externalId).maxItems(32),
  }, { unknownKeys: "reject" })).maxItems(1024),
}, { unknownKeys: "reject" });

export interface VmsProfile { id: string; name: string; role: "main" | "sub" | "other"; codec: string; width: number; height: number; fps: number }
export interface VmsSnapshot {
  version: 1; instanceId: string; revision: number; name: string;
  cameras: Array<{ id: string; name: string; enabled: boolean; profiles: VmsProfile[] }>;
  groups: Array<{ id: string; name: string; cameraIds: string[] }>;
}
export function validateSimpleVmsSnapshot(input: unknown): VmsSnapshot {
  const result = SimpleVmsSnapshot.safeParse(input);
  if (!result.success) throw new Error("Invalid SimpleVMS snapshot");
  const snapshot = result.data as VmsSnapshot;
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(snapshot.cameras.map(c => c.id)) || !unique(snapshot.groups.map(g => g.id))) throw new Error("Duplicate external IDs");
  const cameras = new Set(snapshot.cameras.map(c => c.id));
  for (const camera of snapshot.cameras) {
    if (!unique(camera.profiles.map(p => p.id))) throw new Error("Duplicate profile IDs");
  }
  for (const group of snapshot.groups) {
    if (!unique(group.cameraIds) || group.cameraIds.some(id => !cameras.has(id))) throw new Error("Invalid group membership");
  }
  return snapshot;
}

export function simpleVmsAddress(input: string, external = false): string {
  const url = new URL(input);
  if (!["rtsp:", "rtsps:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) throw new Error("Use an RTSP(S) server address without credentials or path");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (external && (["localhost", "0.0.0.0", "::", "::1"].includes(host) || host.startsWith("127.") || host.endsWith(".localhost"))) throw new Error("Linked kiosks require a reachable external SimpleVMS address");
  return url.toString().replace(/\/$/, "");
}
export function simpleVmsStreamUri(address: string, cameraId: string, profileId: string): string {
  return `${address}/bf/${encodeURIComponent(cameraId)}/${encodeURIComponent(profileId)}`;
}
