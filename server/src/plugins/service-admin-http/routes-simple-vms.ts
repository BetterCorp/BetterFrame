import { getRouterParam, readBody, type H3 } from "h3";
import type { AdminDeps } from "./index.js";
import { htmlPage } from "./html-response.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import { saveSimpleVmsSource, removeSimpleVmsSource, type SimpleVmsSource } from "../../shared/simple-vms.js";
import { SimpleVmsManagedPage, SimpleVmsSettingsPage } from "../../web-templates/simple-vms-pages.js";
import type { Repository } from "../../shared/db/repository.js";

export async function simpleVmsManagedPage(repo: Repository, user: string | undefined, kind: "camera" | "device" | "layout", id: string): Promise<Response | null> {
  const query = kind === "device" ? "SELECT id AS source_id FROM simple_vms_sources WHERE device_id = ?"
    : kind === "camera" ? "SELECT source_id FROM simple_vms_cameras WHERE camera_id = ?"
    : "SELECT source_id FROM simple_vms_groups WHERE layout_id = ?";
  const managed = await repo.adapter.get<{ source_id: string }>(query, [id]);
  if (!managed) return null;
  const source = (await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE id = ?", [managed.source_id]))!;
  const kiosks = await repo.adapter.all<{ name: string }>(`SELECT k.name FROM kiosks k WHERE k.enabled = true AND ? = true
    AND (k.id = ? OR EXISTS (SELECT 1 FROM simple_vms_linked_kiosks l WHERE l.source_id = ? AND l.kiosk_id = k.id))`, [source.enabled, source.owner_kiosk_id, source.id]);
  const resource = kind === "device" ? await repo.getCameraDeviceById(id) : kind === "camera" ? await repo.getCameraById(id) : await repo.getLayoutById(id);
  let items: Array<{ id: string; name: string; href?: string }> = [];
  if (kind === "device") items = (await repo.listCamerasByDevice(id)).map(c => ({ id: c.id, name: c.name, href: `/admin/cameras/${c.id}` }));
  if (kind === "camera") items = (await repo.listCameraStreams(id)).map(s => ({ id: s.id, name: `${s.name} · ${s.encoding ?? "unknown codec"} · ${s.width ?? "?"}×${s.height ?? "?"}` }));
  if (kind === "layout") {
    for (const cell of await repo.listLayoutCells(id)) {
      const cam = cell.camera_id ? await repo.getCameraById(cell.camera_id) : null;
      if (cam) items.push({ id: cam.id, name: cam.name, href: `/admin/cameras/${cam.id}` });
    }
  }
  return htmlPage(SimpleVmsManagedPage({ user, name: resource?.name ?? "SimpleVMS", kind, items, availability: kiosks.map(k => k.name) }));
}

export function registerSimpleVmsAdminRoutes(app: H3, deps: AdminDeps): void {
  app.post("/admin/kiosks/:id/simple-vms/remove", async event => {
    const id = getRouterParam(event, "id") ?? "";
    const source = await deps.repo.adapter.get<{ id: string }>("SELECT id FROM simple_vms_sources WHERE owner_kiosk_id = ?", [id]);
    if (source) for (const kioskId of await removeSimpleVmsSource(deps.repo, source.id)) getCoordinator().notifyKioskBundleChanged(kioskId);
    return new Response(null, { status: 303, headers: { location: `/admin/kiosks/${id}/simple-vms` } });
  });
  app.get("/admin/kiosks/:id/simple-vms", async event => {
    const id = getRouterParam(event, "id") ?? "";
    const kiosk = await deps.repo.getKioskById(id);
    if (!kiosk) return new Response("Kiosk not found", { status: 404 });
    const source = await deps.repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE owner_kiosk_id = ?", [id]);
    const linked = source ? await deps.repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [source.id]) : [];
    const tenantSlug = (event.context as { tenant?: { slug: string } }).tenant?.slug ?? "default";
    const origin = new URL(event.req.url);
    if (event.req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") origin.protocol = "https:";
    const callback = new URL(`/api/simplevms/${encodeURIComponent(tenantSlug)}/${source?.id ?? ""}/events`, origin).toString();
    return htmlPage(SimpleVmsSettingsPage({ user: event.context.user?.username, kiosk, source,
      kiosks: await deps.repo.listKiosks(), linked: linked.map(k => k.kiosk_id), callback }));
  });
  app.post("/admin/kiosks/:id/simple-vms", async event => {
    const id = getRouterParam(event, "id") ?? "";
    const form = await readBody<Record<string, string>>(event) ?? {};
    try {
      const kiosk = await deps.repo.getKioskById(id);
      if (!kiosk) return new Response("Kiosk not found", { status: 404 });
      await saveSimpleVmsSource(deps.repo, deps.secrets, id, {
        instanceId: form["instance_id"] ?? "", name: `${kiosk.name} / SimpleVMS`, localAddress: form["local_address"] ?? "",
        externalAddress: form["external_address"] ?? "", localHttpAddress: form["local_http_address"] ?? "", externalHttpAddress: form["external_http_address"] ?? "", viewerUsername: form["viewer_username"] ?? "",
        viewerPassword: form["viewer_password"] ?? "", ingestToken: form["ingest_token"] ?? "",
        enabled: form["enabled"] === "1", autoSync: form["auto_sync"] === "1",
        linkedKioskIds: Object.keys(form).filter(k => k.startsWith("linked_") && form[k] === "1").map(k => k.slice(7)),
      });
      for (const kiosk of await deps.repo.listKiosks()) getCoordinator().notifyKioskBundleChanged(kiosk.id);
      return new Response(null, { status: 303, headers: { location: `/admin/kiosks/${id}/simple-vms` } });
    } catch (cause) { return new Response(cause instanceof Error ? cause.message : "Invalid connection", { status: 422 }); }
  });
}
