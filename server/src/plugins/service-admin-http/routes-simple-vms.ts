import { getRouterParam, getQuery, readBody, type H3, type H3Event } from "h3";
import type { AdminDeps } from "./index.js";
import { htmlPage } from "./html-response.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import { saveSimpleVmsSource, removeSimpleVmsSource, listSimpleVmsSources, linkSimpleVmsKiosk, reconcileSimpleVmsAssignments, refreshSimpleVmsKioskEnabled, type SimpleVmsSource } from "../../shared/simple-vms.js";
import { SimpleVmsManagedPage, SimpleVmsInstancesPage, SimpleVmsInstancePage, SimpleVmsPairPage, SimpleVmsHandoffPage } from "../../web-templates/simple-vms-pages.js";
import { approveSimpleVmsPairing, validateSimpleVmsPairRequest, simpleVmsBrowserAddress } from "../../shared/simple-vms-pairing.js";
import { simpleVmsAddress } from "../../shared/simple-vms-schema.js";
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
  const origin = (event: H3Event) => {
    const url = new URL(event.req.url);
    if (event.req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") url.protocol = "https:";
    return url.origin;
  };
  const redirect = (location: string) => new Response(null, { status: 303, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  // Establish this origin before entering admin routes so Strict session cookies survive cross-site pairing.
  app.get("/simplevms/pair", event => {
    try {
      const request = validateSimpleVmsPairRequest(getQuery(event));
      const response = htmlPage(SimpleVmsHandoffPage({ location: "/admin/simplevms/pair?" + new URLSearchParams(request) }));
      response.headers.set("cache-control", "no-store"); response.headers.set("referrer-policy", "no-referrer"); return response;
    } catch { return new Response("Invalid SimpleVMS pairing request", { status: 400 }); }
  });
  app.get("/simplevms/instance/:sourceId", event => {
    const id = getRouterParam(event, "sourceId") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(id)) return new Response(null, { status: 400 });
    const response = htmlPage(SimpleVmsHandoffPage({ location: `/admin/simplevms/${id}` }));
    response.headers.set("cache-control", "no-store"); response.headers.set("referrer-policy", "no-referrer"); return response;
  });
  app.get("/admin/simplevms", async event => htmlPage(SimpleVmsInstancesPage({ user: event.context.user?.username,
    sources: await listSimpleVmsSources(deps.repo), frameUrl: origin(event) })));
  app.get("/admin/simplevms/pair", async event => {
    if (event.context.user?.role !== "admin") return new Response("Administrator access required", { status: 403 });
    try {
      const request = validateSimpleVmsPairRequest(getQuery(event));
      const existing = await deps.repo.adapter.get("SELECT 1 FROM simple_vms_sources WHERE instance_id = ?", [request.instance_id]);
      const response = htmlPage(SimpleVmsPairPage({ user: event.context.user.username, request,
        tenantName: event.context.tenant?.name ?? "Default", reconnect: !!existing }));
      response.headers.set("cache-control", "no-store"); response.headers.set("referrer-policy", "same-origin"); return response;
    } catch { return new Response("Invalid pairing request. Start pairing again from SimpleVMS.", { status: 400 }); }
  });
  app.post("/admin/simplevms/pair", async event => {
    if (event.context.user?.role !== "admin") return new Response("Administrator access required", { status: 403 });
    try {
      const request = validateSimpleVmsPairRequest(await readBody<Record<string, unknown>>(event) ?? {});
      const location = await approveSimpleVmsPairing(deps.repo, deps.secrets, request, event.context.tenant?.slug ?? "default", origin(event));
      // Complete the same-origin form POST before navigating back to the recorder; retain form-action 'self'.
      const response = htmlPage(SimpleVmsHandoffPage({ location, destination: "SimpleVMS" }));
      response.headers.set("cache-control", "no-store"); response.headers.set("referrer-policy", "no-referrer"); return response;
    } catch { return new Response("Pairing could not be approved. Start pairing again from SimpleVMS.", { status: 400 }); }
  });
  app.get("/admin/simplevms/:sourceId", async event => {
    const id = getRouterParam(event, "sourceId") ?? "";
    const source = (await listSimpleVmsSources(deps.repo)).find(s => s.id === id);
    if (!source) return new Response("SimpleVMS instance not found", { status: 404 });
    const kiosks = await deps.repo.adapter.all<{ id: string }>(`SELECT k.id FROM kiosks k WHERE k.id = ? OR
      EXISTS (SELECT 1 FROM simple_vms_linked_kiosks l WHERE l.source_id = ? AND l.kiosk_id = k.id)`, [source.owner_kiosk_id, id]);
    const ids = new Set(kiosks.map(k => k.id));
    return htmlPage(SimpleVmsInstancePage({ user: event.context.user?.username, source, kiosks: (await deps.repo.listKiosks()).filter(k => ids.has(k.id)) }));
  });
  app.post("/admin/simplevms/:sourceId", async event => {
    const id = getRouterParam(event, "sourceId") ?? "";
    const form = await readBody<Record<string, string>>(event) ?? {};
    try {
      const local = simpleVmsAddress(form.local_address ?? "");
      const external = form.external_address ? simpleVmsAddress(form.external_address, true) : null;
      const localHttp = simpleVmsBrowserAddress(form.local_http_address ?? "");
      const externalHttp = simpleVmsBrowserAddress(form.external_http_address ?? "");
      await deps.repo.transact(async () => {
        const source = await deps.repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE id = ? FOR UPDATE", [id]);
        if (!source) throw new Error("SimpleVMS instance not found");
        if (!external && await deps.repo.adapter.get("SELECT 1 FROM simple_vms_linked_kiosks WHERE source_id = ? AND use_local_address = false", [id])) throw new Error("A network kiosk is using this media address");
        await deps.repo.adapter.run(`UPDATE simple_vms_sources SET enabled = ?, auto_sync = ?, local_address = ?, external_address = ?,
          local_http_address = ?, external_http_address = ? WHERE id = ?`, [form.enabled === "1", form.auto_sync === "1", local, external, localHttp || null, externalHttp || null, id]);
        await reconcileSimpleVmsAssignments(deps.repo, id);
        for (const kiosk of await deps.repo.listKiosks()) await refreshSimpleVmsKioskEnabled(deps.repo, kiosk.id);
      });
      for (const kiosk of await deps.repo.listKiosks()) getCoordinator().notifyKioskBundleChanged(kiosk.id);
      return redirect(`/admin/simplevms/${id}`);
    } catch (cause) { return new Response(cause instanceof Error ? cause.message : "Invalid connection", { status: 422 }); }
  });
  app.post("/admin/simplevms/:sourceId/remove", async event => {
    for (const id of await removeSimpleVmsSource(deps.repo, getRouterParam(event, "sourceId") ?? "")) getCoordinator().notifyKioskBundleChanged(id);
    return redirect("/admin/simplevms");
  });
  for (const operation of ["link", "unlink"] as const) app.post(`/admin/kiosks/:id/simple-vms/${operation}`, async event => {
    const id = getRouterParam(event, "id") ?? "";
    const form = await readBody<Record<string, string>>(event) ?? {};
    try {
      await linkSimpleVmsKiosk(deps.repo, form.source_id ?? "", id, operation === "link", form.use_local_address === "1");
      getCoordinator().notifyKioskBundleChanged(id);
      return redirect(`/admin/kiosks/${id}#simplevms`);
    } catch (cause) { return new Response(cause instanceof Error ? cause.message : "Invalid connection", { status: 422 }); }
  });
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
    return redirect(`/admin/kiosks/${id}#simplevms`);
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
