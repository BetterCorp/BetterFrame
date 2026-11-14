import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { generateBundle } from "../src/shared/bundle.js";
import { parseSmartUrlForm } from "../src/shared/smart-url.js";
import { EntityEditPage, EntityNewPage, renderCellSidebar } from "../src/web-templates/admin-pages.js";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";

const auth = { login_detect_url: "/auth", steps: [{ type: "fill" as const, selector: "#username", value: "person=example" }] };
function fixture() {
  const entity = { id: "entity", name: "Home Assistant", type: "web", web_url: "http://ha/lovelace/2", smart_url_json: structuredClone(auth), input_options_json: {} };
  const cells = [0, 1].map((col) => ({ id: `block${col}`, entity_id: "entity", content_type: "web", web_url: entity.web_url, row: 0, col, row_span: 1, col_span: 1, options: { smart_url: { steps: [{ type: "navigate", url: "http://wrong" }] } } }));
  let nonce = 0;
  const repo = {
    adapter: { withSearchPath: async (_: string, fn: () => unknown) => fn() },
    getKioskById: async () => ({ id: "kiosk", name: "Kiosk", capabilities: [], enabled: true, operator_console_enabled: true }),
    getTenantBySlug: async () => ({ slug: "default", schema_name: "public", is_active: true }),
    listDisplaysForKiosk: async () => [{ id: "display", name: "Display", is_enabled: true, default_layout_id: "layout" }],
    layoutsForDisplayId: async () => [{ id: "layout", name: "Layout", preload_camera_ids: [] }],
    layoutCells: async () => cells,
    camerasForLayoutIds: async () => [], bundleScope: async () => ({ operateLabelIds: [] }), camerasForLabelIds: async () => [],
    listCameraDevices: async () => [], listGpioBindings: async () => [], releaseStaleEventOwnership: async () => {},
    getEntityById: async () => entity, listEntities: async () => [entity],
  };
  const secrets = { encryptForCluster: (value: string) => `cipher-${++nonce}:${value}` };
  return { entity, cells, repo, secrets };
}

test("entities own auth in every block and fullscreen; legacy layout overrides are ignored", async () => {
  const { entity, repo, secrets } = fixture();
  const bundle = await generateBundle(repo as never, secrets as never, "kiosk", "cluster");
  assert.ok(bundle);
  const cells = bundle.displays[0]!.layouts.flatMap((layout) => layout.cells);
  assert.equal(cells.length, 3);
  for (const cell of cells) {
    assert.equal(cell.smart_url?.login_detect_url, "/auth");
    assert.equal(cell.smart_url?.steps[0]?.type, "fill");
    assert.equal(cell.smart_url?.steps[0]?.value, undefined);
    assert.match(cell.smart_url!.steps[0]!.value_encrypted!, /^cipher-/);
  }
  const repeated = await generateBundle(repo as never, secrets as never, "kiosk", "cluster");
  assert.equal(bundle.version, repeated?.version, "randomized ciphertext cannot trigger reloads");
  entity.smart_url_json.steps[0]!.value = "changed";
  const edited = await generateBundle(repo as never, secrets as never, "kiosk", "cluster");
  assert.notEqual(bundle.version, edited?.version, "entity auth edits must reach kiosks");
  (entity as { smart_url_json: unknown }).smart_url_json = null;
  const removed = await generateBundle(repo as never, secrets as never, "kiosk", "cluster");
  assert.ok(removed);
  for (const layout of removed.displays[0]!.layouts) {
    for (const cell of layout.cells) assert.equal(cell.smart_url, undefined, "legacy layout auth must not return after entity auth is removed");
  }
});

test("step editor retains rows after deletion and preserves equals signs and zero waits", () => {
  assert.deepEqual(parseSmartUrlForm({ smart_url_login_detect: " /auth ", step_0_type: "fill", step_0_value: "#user=person=example", step_2_type: "wait", step_2_value: "0" }), {
    login_detect_url: "/auth", steps: [{ type: "fill", selector: "#user", value: "person=example" }, { type: "wait", delay_ms: 0 }],
  });
  assert.equal(parseSmartUrlForm({ smart_url_login_detect: "/auth", step_0_type: "fill", step_0_value: 'input[name="username"]=user=example' })?.steps[0]?.selector, 'input[name="username"]');
  assert.equal(parseSmartUrlForm({ smart_url_login_detect: "/auth" }), null);
  assert.throws(() => parseSmartUrlForm({ step_0_type: "click", step_0_value: "#login" }), /login URL prefix/);
  assert.throws(() => parseSmartUrlForm({ smart_url_login_detect: "/auth", step_0_type: "wait", step_0_value: "-1" }), /wait times/);
});

test("authentication is edited on entities and linked from layout blocks", () => {
  const { entity, cells } = fixture();
  const edit = String(EntityEditPage({ user: "admin", entity: entity as never, cameras: [] }));
  assert.match(edit, /name="smart_url_login_detect"/);
  assert.match(edit, /value="\/auth"/);
  assert.match(edit, /Run only when this entity redirects/);
  assert.match(String(EntityNewPage({ user: "admin", cameras: [] })), /name="smart_url_login_detect"/);
  const block = String(renderCellSidebar("layout", cells[0] as never, cells as never, [entity] as never, []));
  assert.doesNotMatch(block, /name="step_0_type"|name="smart_url_login_detect"/);
  assert.match(block, /href="\/admin\/entities\/entity"/);
});

test("entity saves persist auth and block saves cannot override it", async () => {
  const { entity, cells, repo } = fixture();
  const patches: Array<Record<string, unknown>> = [];
  const app = new H3();
  app.use((event) => { event.context.user = { username: "admin" } as never; });
  registerAdminRoutes(app, { repo: {
    ...repo, updateEntity: async (_: string, patch: Record<string, unknown>) => { patches.push(patch); },
    getLayoutCellById: async () => cells[0], assignCellEntity: async () => {}, updateLayoutCell: async (_: string, patch: Record<string, unknown>) => { patches.push(patch); },
  } } as never);
  const post = (path: string, body: Record<string, string>) => app.request(`http://bf.test${path}`, { method: "POST", body: new URLSearchParams(body) });
  assert.equal((await post("/admin/entities/entity", { name: entity.name, web_url: entity.web_url, smart_url_login_detect: "/auth", step_0_type: "click", step_0_value: "#login" })).status, 302);
  assert.deepEqual(patches[0]?.["smart_url_json"], { login_detect_url: "/auth", steps: [{ type: "click", selector: "#login" }] });
  patches.length = 0;
  assert.equal((await post("/admin/layouts/layout/cells/block0", { entity_id: "entity", step_0_type: "navigate", step_0_value: "http://wrong", smart_url_login_detect: "/evil" })).status, 302);
  assert.ok(patches.length > 0);
  assert.ok(patches.every((patch) => !("options" in patch) && !("smart_url_json" in patch)));
});
