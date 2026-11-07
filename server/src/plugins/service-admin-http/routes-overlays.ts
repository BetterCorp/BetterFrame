import { type H3, readBody, getRouterParam } from "h3";
import { uuidv7 } from "uuidv7";
import type { AdminDeps } from "./index.js";
import { htmlPage, htmlFragment } from "./html-response.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import { blockOverlay, overlayData, renderOverlay, validateOverlayTemplate } from "../../shared/overlays.js";
import { OverlayTemplatesPage, BlockOverlayEditor } from "../../web-templates/overlay-pages.js";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const failure = (cause: unknown) => json({ error: cause instanceof Error ? cause.message : "Invalid overlay" }, 422);
const parseData = (value: unknown) => overlayData(typeof value === "string" ? JSON.parse(value) : value);

function editorPage(props: Parameters<typeof OverlayTemplatesPage>[0]): Response {
  const response = htmlPage(OverlayTemplatesPage(props));
  // srcdoc inherits its parent's CSP: allow the same image/font resources as playback.
  const policy = response.headers.get("content-security-policy")!;
  response.headers.set("content-security-policy", policy.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: https:") + "; font-src 'self' data: https:");
  return response;
}

export function registerOverlayRoutes(app: H3, deps: AdminDeps): void {
  app.get("/admin/overlays", async event => editorPage({ user: event.context.user?.username, templates: await deps.repo.listOverlayTemplates() }));
  app.get("/admin/overlays/:id", async event => {
    const template = await deps.repo.getOverlayTemplate(getRouterParam(event, "id") ?? "");
    return template ? editorPage({ user: event.context.user?.username, template, templates: await deps.repo.listOverlayTemplates() }) : new Response("Template not found", { status: 404 });
  });
  app.post("/admin/overlays/preview", async event => {
    try {
      const body = await readBody<Record<string, unknown>>(event);
      return json({ document: renderOverlay(String(body?.["html"] ?? ""), parseData(body?.["data"])) });
    } catch (cause) { return failure(cause); }
  });
  app.post("/admin/overlays/:id", async event => {
    const body = await readBody<Record<string, unknown>>(event);
    const id = getRouterParam(event, "id") ?? "";
    if (id !== "new" && !await deps.repo.getOverlayTemplate(id)) return new Response("Template not found", { status: 404 });
    try {
      const name = String(body?.["name"] ?? "").trim();
      const html = String(body?.["html"] ?? "");
      if (!name || name.length > 128) throw new Error("Name must contain 1–128 characters");
      validateOverlayTemplate(html);
      const sample_data = parseData(body?.["sample_data"]);
      renderOverlay(html, sample_data);
      const template = { id: id === "new" ? uuidv7() : id, name, html, sample_data };
      await deps.repo.saveOverlayTemplate(template);
      getCoordinator().notifyBundleChanged();
      return new Response(null, { status: 303, headers: { location: `/admin/overlays/${template.id}` } });
    } catch (cause) { return failure(cause); }
  });
  app.post("/admin/overlays/:id/delete", async event => {
    await deps.repo.deleteOverlayTemplate(getRouterParam(event, "id") ?? "");
    getCoordinator().notifyBundleChanged();
    return new Response(null, { status: 303, headers: { location: "/admin/overlays" } });
  });
  app.get("/admin/overlays/blocks/:cellId", async event => {
    const cell = await deps.repo.getLayoutCellById(getRouterParam(event, "cellId") ?? "");
    return cell ? htmlFragment(BlockOverlayEditor({ cell, templates: await deps.repo.listOverlayTemplates() })) : new Response("Block not found", { status: 404 });
  });
  app.post("/admin/overlays/blocks/:cellId", async event => {
    const cell = await deps.repo.getLayoutCellById(getRouterParam(event, "cellId") ?? "");
    if (!cell) return new Response("Block not found", { status: 404 });
    try {
      const body = await readBody<Record<string, unknown>>(event);
      const template_id = String(body?.["template_id"] ?? "");
      const options = { ...cell.options };
      if (template_id) {
        const template = await deps.repo.getOverlayTemplate(template_id);
        if (!template) return new Response("Template not found", { status: 404 });
        const data = parseData(body?.["data"]);
        renderOverlay(template.html, data);
        options["overlay"] = { template_id, data };
      } else delete options["overlay"];
      await deps.repo.updateLayoutCell(cell.id, { options });
      getCoordinator().notifyBundleChanged();
      return htmlFragment(BlockOverlayEditor({ cell: { ...cell, options }, templates: await deps.repo.listOverlayTemplates(), saved: true }));
    } catch (cause) { return failure(cause); }
  });
  app.get("/api/admin/overlay-templates", async () => json({ templates: await deps.repo.listOverlayTemplates() }));
  app.post("/api/admin/blocks/:cellId/overlay", async event => {
    const cell = await deps.repo.getLayoutCellById(getRouterParam(event, "cellId") ?? "");
    if (!cell) return new Response("Block not found", { status: 404 });
    try {
      const current = blockOverlay(cell.options);
      if (!current) return json({ error: "Assign an overlay template to the block first" }, 409);
      const template = await deps.repo.getOverlayTemplate(current.template_id);
      if (!template) return json({ error: "Template not found" }, 404);
      const body = await readBody<Record<string, unknown>>(event);
      const data = parseData(body?.["data"]);
      renderOverlay(template.html, data);
      await deps.repo.updateLayoutCell(cell.id, { options: { ...cell.options, overlay: { template_id: template.id, data } } });
      getCoordinator().notifyBundleChanged();
      return json({ overlay: { template_id: template.id, data } });
    } catch (cause) { return failure(cause); }
  });
}
