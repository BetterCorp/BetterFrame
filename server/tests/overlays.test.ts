import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { H3 } from "h3";
import { renderOverlay, overlayPlaybackDocument, overlayData, EXAMPLE_OVERLAY, EXAMPLE_OVERLAY_DATA } from "../src/shared/overlays.js";
import { OverlayTemplatesPage } from "../src/web-templates/overlay-pages.js";
import { registerOverlayRoutes } from "../src/plugins/service-admin-http/routes-overlays.js";
import { getCoordinator, setCoordinator } from "../src/shared/coordinator-registry.js";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { Repository } from "../src/shared/db/repository.js";
import { TENANT_MIGRATIONS } from "../src/shared/db/migrations-pg.js";

const require = createRequire(import.meta.url);

test("Handlebars renders CSS math, conditions and lists, escaping values and refusing prototype access", () => {
  const document = renderOverlay(EXAMPLE_OVERLAY, EXAMPLE_OVERLAY_DATA);
  assert.match(document, /--progress: 64/);
  assert.match(document, /calc\(var\(--progress,0\) \* 1%\)/);
  assert.match(document, /Printing · 64%/);
  assert.match(renderOverlay("{{#if open}}Open{{else}}Closed{{/if}}{{#each people}}<b>{{name}}</b>{{/each}}", { open: false, people: [{ name: "<img onerror=bad()>" }] }), /Closed<b>&lt;img onerror&#x3D;bad\(\)&gt;<\/b>/);
  assert.doesNotMatch(renderOverlay("{{lookup this 'constructor'}}", {}), /function Object/);
  assert.match(renderOverlay("{{progress}}", { progress: 0 }), /<body>0<\/body>/);
  assert.throws(() => renderOverlay("{{#if", {}));
  for (const data of [null, [], 1, "x"]) assert.throws(() => overlayData(data));
  assert.throws(() => overlayData({ value: "x".repeat(32769) }));
});

test("preview and playback documents isolate even authored closing tags and scripts", () => {
  const malicious = '</textarea><script>parent.pwned=true</script><style>body{background:red}</style>';
  const rendered = renderOverlay(malicious, {});
  assert.match(rendered, /default-src 'none'/);
  const playback = overlayPlaybackDocument(rendered);
  assert.match(playback, /<iframe sandbox="" srcdoc="/);
  assert.doesNotMatch(playback, /<script>/);
  const page = String(OverlayTemplatesPage({ templates: [], template: { id: "template", name: "Test", html: malicious, sample_data: {} } }));
  assert.match(page, /sandbox=""/);
  assert.doesNotMatch(page, /<script>parent.pwned/);
  assert.match(page, /&lt;\/textarea&gt;/);
});

function fixture() {
  const templates = new Map<string, any>([["template", { id: "template", name: "Printer", html: "<b>{{progress}}</b>", sample_data: { progress: 99 } }]]);
  const cells = new Map<string, any>([["block", { id: "block", options: { untouched: true } }], ["second", { id: "second", options: {} }]]);
  const repo = {
    listOverlayTemplates: async () => [...templates.values()],
    getOverlayTemplate: async (id: string) => templates.get(id) ?? null,
    saveOverlayTemplate: async (template: any) => { templates.set(template.id, template); },
    deleteOverlayTemplate: async (id: string) => { templates.delete(id); },
    getLayoutCellById: async (id: string) => cells.get(id) ?? null,
    updateLayoutCell: async (id: string, patch: any) => { cells.set(id, { ...cells.get(id), ...patch }); },
  };
  const app = new H3();
  registerOverlayRoutes(app, { repo } as never);
  const post = (path: string, data: unknown) => app.request("http://bf.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  return { app, post, repo, cells, templates };
}

test("block bindings retain independent data, reject invalid writes, and never copy sample data", async t => {
  const original = getCoordinator(); let notifications = 0;
  setCoordinator({ ...original, notifyBundleChanged: () => { notifications++; } });
  t.after(() => setCoordinator(original));
  const f = fixture();
  assert.equal((await f.post("/admin/overlays/blocks/block", { template_id: "template", data: "{}" })).status, 200);
  assert.deepEqual(f.cells.get("block").options, { untouched: true, overlay: { template_id: "template", data: {} } });
  assert.equal((await f.post("/api/admin/blocks/block/overlay", { data: { progress: 64 } })).status, 200);
  assert.deepEqual(f.cells.get("block").options.overlay.data, { progress: 64 });
  assert.deepEqual(f.cells.get("second").options, {});
  assert.equal((await f.post("/api/admin/blocks/second/overlay", { data: {} })).status, 409);
  assert.equal((await f.post("/api/admin/blocks/missing/overlay", { data: {} })).status, 404);
  assert.equal((await f.post("/api/admin/blocks/block/overlay", { data: [] })).status, 422);
  const missingTemplate = await f.post("/admin/overlays/blocks/block", { template_id: "other", data: {} });
  assert.equal(missingTemplate.status, 200);
  assert.match(await missingTemplate.text(), /role="alert"[^>]*>Overlay template not found/);
  assert.deepEqual(f.cells.get("block").options.overlay.data, { progress: 64 });
  assert.equal(notifications, 2);
  assert.equal((await f.post("/admin/overlays/blocks/block", { template_id: "", data: "bad JSON ignored on remove" })).status, 200);
  assert.deepEqual(f.cells.get("block").options, { untouched: true });
});

test("preview validates JSON/templates and template CRUD uses the same rendering", async () => {
  const f = fixture();
  const response = await f.post("/admin/overlays/preview", { html: EXAMPLE_OVERLAY, data: { ...EXAMPLE_OVERLAY_DATA, progress: 12 } });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { document: string }).document, renderOverlay(EXAMPLE_OVERLAY, { ...EXAMPLE_OVERLAY_DATA, progress: 12 }));
  assert.equal((await f.post("/admin/overlays/preview", { html: "{{#if", data: {} })).status, 422);
  assert.equal((await f.post("/admin/overlays/preview", { html: "ok", data: "broken JSON" })).status, 422);
  const saved = await f.post("/admin/overlays/new", { name: "Gate", html: "{{state}}", sample_data: '{"state":"Open"}' });
  assert.equal(saved.status, 303);
  const id = saved.headers.get("location")!.split("/").at(-1)!;
  assert.deepEqual(f.templates.get(id).sample_data, { state: "Open" });
  assert.equal((await f.app.request("http://bf.test/admin/overlays/" + id)).status, 200);
  assert.equal((await f.post(`/admin/overlays/${id}/delete`, {})).status, 303);
  assert.equal((await f.app.request("http://bf.test/admin/overlays/" + id)).status, 404);
});

test("Node-RED overlay node sends complete data with tenant-scoped authentication", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let input: any, Constructor: any, sent: any, completed: any;
  const calls: any[] = [];
  globalThis.fetch = (async (url: unknown, init: any) => { calls.push({ url, init }); return Response.json({ overlay: { data: { progress: 0 } } }); }) as typeof fetch;
  require("../../nodered/src/bf-overlay.js")({ nodes: {
    registerType: (_name: string, value: any) => { Constructor = value; },
    getNode: () => ({ server_url: "https://bf.test/", api_key: "test-key", tenant_slug: "tenant-a" }),
    createNode: (node: any) => { node.on = (_event: string, handler: any) => { input = handler; }; node.status = () => {}; },
  } });
  new Constructor({ block_id: "block" });
  await input({ payload: { progress: 0 } }, (msg: any) => { sent = msg; }, (err: any) => { completed = err; });
  assert.equal(completed, undefined);
  assert.equal(calls[0].url, "https://bf.test/api/admin/blocks/block/overlay");
  assert.equal(calls[0].init.headers["x-betterframe-tenant"], "tenant-a");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { data: { progress: 0 } });
  assert.deepEqual(sent.payload, { data: { progress: 0 } });
  await input({ payload: [] }, () => assert.fail("invalid data sent"), (err: any) => { completed = err; });
  assert.match(String(completed), /JSON object/);
  assert.equal(calls.length, 1);
});

test("PostgreSQL overlay migration and repository remain tenant scoped and survive reopening", { skip: !process.env["BF_TEST_PG_URL"] }, async () => {
  const url = process.env["BF_TEST_PG_URL"]!;
  const adapter = new PgAdapter(url);
  const schemas = [0, 1].map(() => "overlay_test_" + randomBytes(6).toString("hex"));
  const migration = TENANT_MIGRATIONS.find(sql => sql.startsWith("CREATE TABLE overlay_templates"))!;
  const template = { id: "same-id", name: "Printer", html: "{{progress}}", sample_data: { progress: 64 } };
  try {
    for (const schema of schemas) {
      await adapter.exec(`CREATE SCHEMA ${schema}`);
      await adapter.withSearchPath(schema, async () => {
        await adapter.exec(migration);
        await adapter.exec("CREATE TABLE layout_cells (id TEXT PRIMARY KEY, layout_id TEXT, options JSONB NOT NULL DEFAULT '{}')");
        await adapter.run("INSERT INTO layout_cells(id, layout_id) VALUES (?, ?)", ["block", "layout"]);
      });
    }
    const repo = new Repository(adapter, async () => {});
    await adapter.withSearchPath(schemas[0]!, async () => {
      await repo.saveOverlayTemplate(template);
      const cell = await repo.getLayoutCellById("block");
      const app = new H3();
      registerOverlayRoutes(app, { repo } as never);
      const assigned = await app.request("http://bf.test/admin/overlays/blocks/block", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_id: template.id, data: { progress: 0 } }),
      });
      assert.equal(assigned.status, 200);
      assert.deepEqual((await repo.getLayoutCellById("block"))?.options, {
        ...cell?.options, overlay: { template_id: template.id, data: { progress: 0 } },
      });
      assert.equal((await adapter.get<{ kind: string }>("SELECT jsonb_typeof(options) AS kind FROM layout_cells WHERE id = ?", ["block"]))?.kind, "object");
      assert.deepEqual(await repo.getOverlayTemplate(template.id), template);
      await repo.saveOverlayTemplate({ ...template, html: "Updated {{progress}}" });
      assert.equal((await repo.listOverlayTemplates()).length, 1);
    });
    await adapter.withSearchPath(schemas[1]!, async () => {
      assert.equal(await repo.getOverlayTemplate(template.id), null);
      assert.deepEqual((await repo.getLayoutCellById("block"))?.options, {});
      await repo.saveOverlayTemplate({ ...template, name: "Gate" });
      await repo.deleteOverlayTemplate(template.id);
    });
    const reopened = new PgAdapter(url);
    try {
      await reopened.withSearchPath(schemas[0]!, async () => assert.equal((await new Repository(reopened, async () => {}).getOverlayTemplate(template.id))?.html, "Updated {{progress}}"));
    } finally { await reopened.close(); }
  } finally {
    for (const schema of schemas) await adapter.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adapter.close();
  }
});

test("rendering bounds intermediate output and interrupts empty exponential loops", () => {
  assert.throws(() => renderOverlay("{{#each items}}{{../text}}{{/each}}", {
    items: Array(64).fill(0), text: "x".repeat(20000),
  }), /512 KiB output budget/);
  const started = performance.now();
  assert.throws(() => renderOverlay("{{#each a}}{{#each ../a}}{{#each ../../a}}{{/each}}{{/each}}{{/each}}", {
    a: Array(1000).fill(0),
  }), /rendering exceeded 100 ms/);
  assert.ok(performance.now() - started < 2000, "pathological loops must terminate promptly");
  assert.match(renderOverlay("{{name}}", { name: "Recovered" }), /<body>Recovered<\/body>/);
  assert.match(renderOverlay("{{#each a}}{{#each ../a}}{{#each ../../a}}{{/each}}{{/each}}{{/each}}", { a: [] }), /<body><\/body>/);
});

test("invalid browser submissions preserve drafts and display errors without saving", async () => {
  const f = fixture();
  const html = "<style>.bar{width:25%}</style><b>{{progress}}</b>";
  const invalid = '{"progress":';
  const response = await f.post("/admin/overlays/new", { name: "Keep <draft>", html, sample_data: invalid });
  assert.equal(response.status, 422);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const page = await response.text();
  assert.match(page, /role="alert"/);
  assert.ok(page.includes('value="Keep &lt;draft&gt;"') || page.includes('value="Keep <draft>"'));
  assert.ok(page.includes('&lt;style&gt;.bar{width:25%}&lt;/style&gt;'));
  assert.ok(page.includes('{&quot;progress&quot;:'));
  assert.equal(f.templates.size, 1);
  const block = await f.post("/admin/overlays/blocks/block", { template_id: "template", data: invalid });
  assert.equal(block.status, 200, "htmx swaps this error fragment");
  const fragment = await block.text();
  assert.match(fragment, /role="alert"/);
  assert.ok(fragment.includes('{&quot;progress&quot;:'));
  assert.match(fragment, /value="template" selected/);
  assert.deepEqual(f.cells.get("block").options, { untouched: true });
  const api = await f.post("/api/admin/blocks/block/overlay", { data: [] });
  assert.equal(api.status, 409);
  assert.match(api.headers.get("content-type") ?? "", /application\/json/);
});

test("the block editor can load and repair malformed retained overlay data", async () => {
  const f = fixture();
  f.cells.get("block").options.overlay = { template_id: "template", data: ["corrupt"] };
  const response = await f.app.request("http://bf.test/admin/overlays/blocks/block");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Stored overlay data is invalid/);
  assert.equal((await f.post("/admin/overlays/blocks/block", { template_id: "template", data: '{"progress":25}' })).status, 200);
  assert.deepEqual(f.cells.get("block").options.overlay.data, { progress: 25 });
});
