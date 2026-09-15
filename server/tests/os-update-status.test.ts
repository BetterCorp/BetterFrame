import assert from "node:assert/strict";
import test from "node:test";
import { reconcileOsUpdateReport } from "../src/shared/os-update-status.js";
import { KioskOsUpdatePanel } from "../src/web-templates/admin-pages.js";
import type { Kiosk } from "../src/shared/types.js";

const previous = (state: Kiosk["os_update_state"], version = "1.0.0", error: string | null = null) => ({
  os_update_last_attempt_version: version, os_update_state: state, os_update_last_error: error,
});

test("old slot confirmation preserves pending target without inventing a rollback", () => {
  const report = reconcileOsUpdateReport(previous("pending_reboot"), { version: "0.0.318", state: "confirmed", error: null });
  assert.equal(report?.version, "1.0.0");
  assert.equal(report?.state, "pending_reboot");
  assert.match(report!.error!, /Running OS 0.0.318 has not confirmed update 1.0.0/);
  assert.equal(reconcileOsUpdateReport(previous("pending_reboot", "1.0.0", report!.error), { version: "0.0.318", state: "confirmed", error: null }), null);
});

test("explicit rollback keeps attempted target and recovery diagnostic until confirmed", () => {
  const rollback = { version: "1.0.0", state: "rolled_back" as const, error: "Boot returned to OS 0.0.318; target 1.0.0 was not confirmed" };
  assert.deepEqual(reconcileOsUpdateReport(previous("pending_reboot"), rollback), rollback);
  assert.equal(reconcileOsUpdateReport(previous("rolled_back", rollback.version, rollback.error), { version: "0.0.318", state: "confirmed", error: null }), null);
  const confirmed = { version: "1.0.0", state: "confirmed" as const, error: null };
  assert.deepEqual(reconcileOsUpdateReport(previous("rolled_back", rollback.version, rollback.error), confirmed), confirmed);
});

test("delayed install and failure reports cannot undo a successful confirmation", () => {
  for (const version of ["0.0.318", "1.0.0"]) {
    for (const state of ["failed", "pending_reboot", "installed"] as const) {
      assert.equal(reconcileOsUpdateReport(previous("confirmed"), { version, state, error: "late report" }), null);
    }
  }
  const next = { version: "1.0.1", state: "pending_reboot" as const, error: null };
  assert.deepEqual(reconcileOsUpdateReport(previous("confirmed"), next), next);
});

test("admin OS panel exposes pending, rollback and failure with recovery controls", () => {
  for (const state of ["pending_reboot", "rolled_back", "failed"] as const) {
    const kiosk = { id: "kiosk", os_version: "0.0.318", ...previous(state), os_update_last_error: "Install stage: reboot not confirmed", logging_json: "{}" } as Kiosk;
    const html = String(KioskOsUpdatePanel({ kiosk, releases: [] }));
    assert.match(html, /Last attempt:.*1.0.0/);
    assert.match(html, /Install stage: reboot not confirmed/);
    assert.match(html, state === "pending_reboot" ? /Awaiting reboot and boot confirmation/ : /Retry OS update now/);
  }
});

test("both OS reporting endpoints reconcile against stored kiosk state", async () => {
  const { H3 } = await import("h3");
  const { registerKioskRoutes } = await import("../src/plugins/service-api-http/index.js");
  const writes: unknown[][] = [];
  const app = new H3();
  app.use((event) => { event.context.verifiedKiosk = { id: "kiosk" }; });
  registerKioskRoutes(app, {
    getKioskById: async () => ({ id: "kiosk", ...previous("confirmed") }),
    recordKioskOsUpdateAttempt: async (...args: unknown[]) => { writes.push(args); },
    insertEvent: async () => {},
  } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, "");
  for (const path of ["applied", "status"]) {
    const response = await app.request(`http://bf.test/api/kiosk/os/${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "0.0.318", error: "delayed install failure", ...(path === "status" ? { state: "failed" } : {}) }),
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(writes, []);
});


test("a later boot rollback supersedes confirmation of the same target", () => {
  const rollback = { version: "1.0.0", state: "rolled_back" as const, error: "Later boot returned to running OS 0.0.318 instead of confirmed target 1.0.0" };
  assert.deepEqual(reconcileOsUpdateReport(previous("confirmed"), rollback), rollback);
  // A delayed rollback for an older release must still leave a newer result alone.
  assert.equal(reconcileOsUpdateReport(previous("confirmed", "1.0.1"), rollback), null);
});
