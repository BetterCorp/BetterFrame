import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { subscribeEvent } = require("../../nodered/src/_event-dispatch.js");

test("layout triggers preserve source and filter independently within tenant and display scope", async () => {
  const prior = process.env["BF_NODERED_INTERNAL_TOKEN"];
  process.env["BF_NODERED_INTERNAL_TOKEN"] = "test-only-runtime-token-000000000000000";
  try {
    let dispatch: any;
    let Trigger: any;
    const RED = {
      httpNode: { post: (_path: string, fn: unknown) => { dispatch = fn; } },
      nodes: {
        registerType: (_name: string, ctor: unknown) => { Trigger = ctor; },
        getNode: () => ({ tenant_slug: "tenant-a" }),
        createNode: (node: any) => {
          node.messages = [];
          node.send = (msg: unknown) => node.messages.push(msg);
          node.status = () => {};
          node.on = () => {};
        },
      },
    };
    require("../../nodered/src/bf-trigger-layout-changed.js")(RED);
    // Register a filtered subscriber first to verify rejected events still fan out.
    const server = new Trigger({ source: "server", display_id: "display-a" });
    const kiosk = new Trigger({ source: "kiosk", display_id: "display-a" });
    const legacy = new Trigger({ display_id: "display-a" });
    const all = new Trigger({ source: "", display_id: "display-a" });
    const everyDisplay = new Trigger({ source: "kiosk" });
    const emit = async (fields: Record<string, unknown>) => {
      const response = { code: 0, status(n: number) { this.code = n; return this; }, end() {} };
      await dispatch({
        headers: { "x-betterframe-runtime-token": process.env["BF_NODERED_INTERNAL_TOKEN"] },
        body: { tenant_slug: "tenant-a", display_id: "display-a", kiosk_id: "kiosk-a", layout_id: "layout-a", layout_name: "Main", ...fields },
      }, response);
      assert.equal(response.code, 200);
    };
    await emit({ source: "server" });
    await emit({ source: "kiosk" });
    await emit({});
    await emit({ source: "future-source" });
    await emit({ source: "kiosk", tenant_slug: "tenant-b" });
    await emit({ source: "kiosk", display_id: "display-b" });
    const sources = (node: any) => node.messages.map((msg: any) => msg.payload.source);
    assert.deepEqual(sources(server), ["server"]);
    assert.deepEqual(sources(kiosk), ["kiosk"]);
    assert.deepEqual(sources(legacy), ["server", "kiosk", null, "future-source"]);
    assert.deepEqual(all.messages, legacy.messages);
    assert.deepEqual(sources(everyDisplay), ["kiosk", "kiosk"]);
    assert.equal(kiosk.messages[0].topic, "layout.changed");
    assert.equal(kiosk.messages[0].payload.layout_id, "layout-a");
    assert.equal(kiosk.messages[0].payload.tenant_key, "tenant-a");
  } finally {
    if (prior === undefined) delete process.env["BF_NODERED_INTERNAL_TOKEN"];
    else process.env["BF_NODERED_INTERNAL_TOKEN"] = prior;
  }
});

test("internal events require a runtime credential and fan out to every subscriber", async () => {
  const prior = process.env["BF_NODERED_INTERNAL_TOKEN"];
  process.env["BF_NODERED_INTERNAL_TOKEN"] = "test-only-runtime-token-000000000000000";
  try {
    let dispatch: any;
    let registrations = 0;
    const RED = { httpNode: { post: (_path: string, fn: unknown) => { dispatch = fn; registrations++; } } };
    const seen: string[] = [];
    const off = subscribeEvent(RED, "/api/internal/event", async (_req: unknown, res: any) => { seen.push("first"); res.status(200).end(); });
    subscribeEvent(RED, "/api/internal/event", async () => { seen.push("second"); });
    const response = { code: 0, status(n: number) { this.code = n; return this; }, end() {} };
    await dispatch({ headers: {}, body: { tenant_slug: "default" } }, response);
    assert.equal(response.code, 403);
    assert.deepEqual(seen, []);
    const request = { headers: { "x-betterframe-runtime-token": process.env["BF_NODERED_INTERNAL_TOKEN"] }, body: {} };
    await dispatch(request, response);
    assert.equal(registrations, 1);
    assert.deepEqual(seen, ["first", "second"]);
    off(); seen.length = 0;
    await dispatch(request, response);
    assert.deepEqual(seen, ["second"]);
  } finally {
    if (prior === undefined) delete process.env["BF_NODERED_INTERNAL_TOKEN"];
    else process.env["BF_NODERED_INTERNAL_TOKEN"] = prior;
  }
});
