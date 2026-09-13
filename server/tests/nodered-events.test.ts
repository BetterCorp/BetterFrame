import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { subscribeEvent } = require("../../nodered/src/_event-dispatch.js");

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
