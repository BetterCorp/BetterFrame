import { getRouterParam, type H3 } from "h3";
import type { Repository } from "./db/repository.js";
import { applySimpleVmsSnapshot, getSimpleVmsSource, simpleVmsTokenMatches } from "./simple-vms.js";
import { getCoordinator } from "./coordinator-registry.js";
import { isAndroidViewer, viewerAssignment } from "./android-viewer.js";
import type { SecretsApi } from "./secrets.js";
import { claimSimpleVmsPairing } from "./simple-vms-pairing.js";

async function assignedViewerCameraIds(repo: Repository, kiosk: import("./types.js").Kiosk): Promise<Set<string>> {
  const assignment = await viewerAssignment(repo, kiosk);
  const ids = new Set<string>();
  for (const layoutId of assignment.layoutIds) for (const cell of await repo.layoutCells(layoutId)) {
    const entity = cell.entity_id ? await repo.getEntityById(cell.entity_id) : null;
    const id = entity ? entity.type === "camera" ? entity.camera_id : null : cell.content_type === "camera" ? cell.camera_id : null;
    if (id) ids.add(id);
  }
  return ids;
}

async function readerGrants(repo: Repository, source: import("./simple-vms.js").SimpleVmsSource) {
  source = await getSimpleVmsSource(repo, source.id) ?? source;
  const linked = await repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [source.id]);
  const cameras = await repo.adapter.all<{ external_id: string; camera_id: string }>("SELECT m.external_id, m.camera_id FROM simple_vms_cameras m JOIN cameras c ON c.id = m.camera_id WHERE m.source_id = ? AND c.enabled = true", [source.id]);
  const grants = [];
  for (const id of [source.owner_kiosk_id, ...linked.map(k => k.kiosk_id)].filter((id): id is string => !!id)) {
    const kiosk = await repo.getKioskById(id); if (!source.enabled || !kiosk?.enabled) continue;
    const assigned = isAndroidViewer(kiosk) ? await assignedViewerCameraIds(repo, kiosk) : null;
    grants.push({ kioskId: id, cameraIds: cameras.filter(c => !assigned || assigned.has(c.camera_id)).map(c => c.external_id) });
  }
  return grants;
}

export async function boundedSimpleVmsJson(request: Request, limit = 4 * 1024 * 1024): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error("Request is too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function registerSimpleVmsIngress(app: H3, repo: Repository, secrets?: SecretsApi): void {
  app.post("/api/simplevms/:tenantSlug/pair/claim", async event => {
    const tenant = await repo.getTenantBySlug(getRouterParam(event, "tenantSlug") ?? "");
    if (!tenant?.is_active || !secrets) return new Response(null, { status: 404 });
    return repo.adapter.withSearchPath(tenant.schema_name, async () => {
      try {
        const body = await boundedSimpleVmsJson(event.req, 8192) as Record<string, unknown>;
        if (!body || typeof body.code !== "string" || typeof body.verifier !== "string" || typeof body.instanceId !== "string") throw new Error("Invalid pairing proof");
        const grant = await claimSimpleVmsPairing(repo, secrets, { code: body.code, verifier: body.verifier, instanceId: body.instanceId });
        const linked = await repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [grant.sourceId]);
        for (const { kiosk_id } of linked) getCoordinator().notifyKioskBundleChanged(kiosk_id);
        return Response.json(grant, { headers: { "cache-control": "no-store", "pragma": "no-cache" } });
      } catch { return Response.json({ error: "Pairing could not be completed. Start pairing again from SimpleVMS." }, { status: 400, headers: { "cache-control": "no-store" } }); }
    });
  });
  app.get("/api/simplevms/:tenantSlug/:sourceId/access", async event => {
    const tenant = await repo.getTenantBySlug(getRouterParam(event, "tenantSlug") ?? "");
    if (!tenant?.is_active) return new Response(null, { status: 404 });
    return repo.adapter.withSearchPath(tenant.schema_name, async () => {
      const source = await getSimpleVmsSource(repo, getRouterParam(event, "sourceId") ?? "");
      const header = event.req.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!source || token.length > 256 || !simpleVmsTokenMatches(source, token)) return new Response(null, { status: 401 });
      const kioskId = new URL(event.req.url).searchParams.get("kioskId") ?? "";
      const kiosk = kioskId.length <= 128 ? await repo.getKioskById(kioskId) : null;
      const linked = kiosk && await repo.adapter.get("SELECT 1 FROM simple_vms_linked_kiosks WHERE source_id = ? AND kiosk_id = ?", [source.id, kioskId]);
      let allowed = !!(source.enabled && kiosk?.enabled && (kioskId === source.owner_kiosk_id || linked));
      const cameraId = new URL(event.req.url).searchParams.get("cameraId");
      if (allowed && cameraId) {
        const camera = cameraId.length <= 128 ? await repo.adapter.get<{ camera_id: string }>("SELECT m.camera_id FROM simple_vms_cameras m JOIN cameras c ON c.id = m.camera_id WHERE m.source_id = ? AND m.external_id = ? AND c.enabled = true", [source.id, cameraId]) : null;
        allowed = !!camera;
        if (allowed && camera && isAndroidViewer(kiosk)) {
          allowed = (await assignedViewerCameraIds(repo, kiosk!)).has(camera.camera_id);
        }
      }
      return Response.json({ allowed }, { headers: { "cache-control": "no-store" } });
    });
  });
  app.post("/api/simplevms/:tenantSlug/:sourceId/events", async event => {
    const slug = getRouterParam(event, "tenantSlug") ?? "";
    const sourceId = getRouterParam(event, "sourceId") ?? "";
    const tenant = await repo.getTenantBySlug(slug);
    if (!tenant?.is_active) return new Response(null, { status: 404 });
    return repo.adapter.withSearchPath(tenant.schema_name, async () => {
      const source = await getSimpleVmsSource(repo, sourceId);
      const header = event.req.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!source || token.length > 256 || !simpleVmsTokenMatches(source, token)) return new Response(null, { status: 401 });
      if (!source.enabled || !source.auto_sync) return new Response(null, { status: 409 });
      try {
        const result = await applySimpleVmsSnapshot(repo, sourceId, await boundedSimpleVmsJson(event.req));
        if (result.applied) {
          const linked = await repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [sourceId]);
          for (const kioskId of [source.owner_kiosk_id, ...linked.map(k => k.kiosk_id)].filter((id): id is string => !!id)) getCoordinator().notifyKioskBundleChanged(kioskId);
        }
        return Response.json({ ...result, grants: await readerGrants(repo, source) });
      } catch { return Response.json({ error: "SimpleVMS snapshot could not be applied" }, { status: 422 }); }
    });
  });
}
