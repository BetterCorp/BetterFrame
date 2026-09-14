import assert from "node:assert/strict";
import test from "node:test";
import { bindPowerSession, unbindPowerSession, readPowerSample, powerSampleAllowed, advancePowerSample, withPowerStateLock } from "../src/shared/power-state-order.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const sample = (revision: number) => ({ sessionId, revision });

test("power revision follows authenticated session ownership across replacement and reconnect", () => {
  const owner = {}, replacement = {};
  bindPowerSession("ordering", owner, sample(2));
  try {
    assert.equal(powerSampleAllowed("ordering", sample(1)), false);
    advancePowerSample("ordering", sample(4));
    bindPowerSession("ordering", replacement, sample(3));
    unbindPowerSession("ordering", owner);
    assert.equal(powerSampleAllowed("ordering", sample(3)), false);
    assert.equal(powerSampleAllowed("ordering", sample(4)), true);
    bindPowerSession("ordering", replacement, { sessionId: "22222222-2222-4222-8222-222222222222", revision: 0 });
    assert.equal(powerSampleAllowed("ordering", sample(99)), false);
    unbindPowerSession("ordering", replacement);
    assert.equal(powerSampleAllowed("ordering", sample(99)), false);
    bindPowerSession("ordering", replacement, sample(5));
    assert.equal(powerSampleAllowed("ordering", sample(4)), false, "Reconnect query supplies its current revision floor");
  } finally { unbindPowerSession("ordering", replacement); }
});

test("malformed power revisions and session IDs fail closed", () => {
  for (const power_revision of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(readPowerSample({ power_session_id: sessionId, power_revision }), null);
  }
  assert.equal(readPowerSample({ power_session_id: "invalid", power_revision: 0 }), null);
  assert.deepEqual(readPowerSample({ power_session_id: sessionId, power_revision: 0 }), sample(0));
});

test("power mutation lock is reentrant, releases after errors and serializes asynchronous writes", async () => {
  const steps: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = withPowerStateLock("locked", async () => {
    await withPowerStateLock("locked", async () => { steps.push("sample"); });
    entered(); await blocked; steps.push("write"); throw new Error("failure");
  });
  await started;
  const rejected = assert.rejects(first, /failure/);
  const second = withPowerStateLock("locked", async () => { steps.push("next-command"); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ["sample"]);
  release(); await rejected; await second;
  assert.deepEqual(steps, ["sample", "write", "next-command"]);
});
