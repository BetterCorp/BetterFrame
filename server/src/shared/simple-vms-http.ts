import { getRouterParam, type H3 } from "h3";
import type { Repository } from "./db/repository.js";
import { applySimpleVmsSnapshot, getSimpleVmsSource, simpleVmsTokenMatches } from "./simple-vms.js";
import { getCoordinator } from "./coordinator-registry.js";

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4 * 1024 * 1024) throw new Error("Snapshot is too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function registerSimpleVmsIngress(app: H3, repo: Repository): void {
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
      return Response.json({ allowed: !!(source.enabled && kiosk?.enabled && (kioskId === source.owner_kiosk_id || linked)) }, { headers: { "cache-control": "no-store" } });
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
        const result = await applySimpleVmsSnapshot(repo, sourceId, await boundedJson(event.req));
        if (result.applied) {
          const linked = await repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [sourceId]);
          for (const kioskId of [source.owner_kiosk_id, ...linked.map(k => k.kiosk_id)]) getCoordinator().notifyKioskBundleChanged(kioskId);
        }
        return Response.json(result);
      } catch { return Response.json({ error: "SimpleVMS snapshot could not be applied" }, { status: 422 }); }
    });
  });
}
