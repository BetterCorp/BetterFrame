import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";
import { getCoordinator, setCoordinator } from "../src/shared/coordinator-registry.js";

function fixture(capabilities: string[], delivered: boolean, enabled = true, assigned = true, extraDisplay = false) {
  const commands: { id: string; message: object; queue?: boolean }[] = [];
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const kioskUpdates: { id: string; patch: Record<string, unknown> }[] = [];
  const events: unknown[][] = [];
  const audits: Record<string, unknown>[] = [];
  const display = { id: "display", kiosk_id: "kiosk", actual_power_state: "unknown", is_enabled: assigned };
  const displays = [display, ...(extraDisplay ? [{ ...display, id: "second-display" }] : [])];
  const app = new H3();
  registerAdminRoutes(app, {
    repo: {
      getKioskById: async () => ({ id: "kiosk", capabilities, enabled }),
      getDisplayById: async () => display,
      listDisplaysForKiosk: async () => displays,
      updateDisplay: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
      updateKiosk: async (id: string, patch: Record<string, unknown>) => { kioskUpdates.push({ id, patch }); },
      insertAudit: async (entry: Record<string, unknown>) => { audits.push(entry); },
    },
    nodered: { forward: (...args: unknown[]) => { events.push(args); } },
  } as never);
  setCoordinator({
    ...getCoordinator(),
    sendToKiosk: (id, message, queue) => { commands.push({ id, message, queue }); return delivered; },
    sendPowerToKiosk: async (id, message) => { commands.push({ id, message, queue: false }); return delivered; },
  });
  return { app, commands, updates, kioskUpdates, events, audits, displays };
}

test("power routes reject unsupported or undelivered commands without reporting a state change", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const target of ["displays/display", "kiosks/kiosk"]) {
    for (const command of ["wake", "standby"]) {
      for (const mode of ["viewer", "offline-viewer", "undelivered", "disabled"]) {
        const viewer = mode.endsWith("viewer");
        const f = fixture(viewer ? ["android-viewer"] : ["linux"], mode === "viewer", mode !== "disabled");
        const response = await f.app.request(`http://bf.test/admin/${target}/power/${command}`, { method: "POST" });
        assert.equal(response.status, 409, `${mode}: ${target}/${command}`);
        assert.equal(response.headers.get("location"), null);
        assert.deepEqual(f.updates, []);
        assert.deepEqual(f.events, []);
        assert.deepEqual(f.audits, []);
        assert.equal(f.commands.length, mode === "undelivered" ? 1 : 0);
        if (mode === "undelivered") assert.equal(f.commands[0]?.queue, false);
      }
    }
  }
});

test("viewer reboot and every audio action reject direct requests before sending or saving settings", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const delivered of [true, false]) {
    for (const action of ["reboot", "apply", "mute", "unmute", "output", "save_default"]) {
      const f = fixture(["android-viewer", "android-standby-v1"], delivered);
      const response = await f.app.request(`http://bf.test/admin/kiosks/kiosk/${action === "reboot" ? "reboot" : "volume"}`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action, volume: "75", output_id: "hdmi" }).toString(),
      });
      assert.equal(response.status, 409, action);
      assert.equal(response.headers.get("location"), null);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.kioskUpdates, []);
      assert.deepEqual(f.updates, []);
    }
  }
});

test("desktop reboot and saved boot volume remain available", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const capabilities of [["linux"], ["windows"]]) {
    const f = fixture(capabilities, false);
    assert.equal((await f.app.request("http://bf.test/admin/kiosks/kiosk/reboot", { method: "POST" })).status, 302);
    const response = await f.app.request("http://bf.test/admin/kiosks/kiosk/volume", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=save_default&volume=75",
    });
    assert.equal(response.status, 302);
    assert.deepEqual(f.kioskUpdates, [{ id: "kiosk", patch: { audio_default_volume_percent: 75 } }]);
    assert.deepEqual(f.commands.map(({ message }) => message), [{ type: "reboot" }, { type: "volume-set", volume: 75 }]);
  }
});

test("delivered desktop power commands preserve state, event and audit behavior", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const target of ["displays/display", "kiosks/kiosk"]) {
    for (const command of ["wake", "standby"]) {
      const f = fixture(["windows"], true);
      const response = await f.app.request(`http://bf.test/admin/${target}/power/${command}`, { method: "POST" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `/admin/${target}`);
      assert.deepEqual(f.commands, [{ id: "kiosk", message: {
        type: command, ...(target.startsWith("displays") ? { display_id: "display" } : {}),
      }, queue: false }]);
      assert.equal(f.updates.length, 1);
      assert.equal(f.updates[0]?.patch.actual_power_state, command === "wake" ? "awake" : "standby");
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0]?.[0], "display.power.changed");
      assert.equal(f.audits.length, target.startsWith("kiosks") ? 1 : 0);
      if (f.audits.length) assert.equal(f.audits[0]?.action, `display.${command}`);
    }
  }
});


test("new Android standby routes deliver only to the active display and refuse offline or unassigned targets", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const target of ["displays/display", "kiosks/kiosk"]) {
    for (const command of ["wake", "standby"]) {
      for (const [delivered, assigned] of [[true, true], [false, true], [true, false]] as const) {
        const f = fixture(["android-viewer", "android-standby-v1"], delivered, true, assigned);
        const response = await f.app.request(`http://bf.test/admin/${target}/power/${command}`, { method: "POST" });
        assert.equal(response.status, delivered && assigned ? 302 : 409);
        assert.deepEqual(f.commands, assigned ? [{ id: "kiosk", message: { type: command, display_id: "display" }, queue: false }] : []);
        assert.equal(f.updates.length, delivered && assigned ? 1 : 0);
        assert.equal(f.events.length, delivered && assigned ? 1 : 0);
      }
    }
  }
  const ambiguous = fixture(["android-viewer", "android-standby-v1"], true, true, true, true);
  assert.equal((await ambiguous.app.request("http://bf.test/admin/kiosks/kiosk/power/wake", { method: "POST" })).status, 409);
  assert.deepEqual(ambiguous.commands, []);
  const f = fixture(["android-viewer", "android-standby-v1"], true);
  const response = await f.app.request("http://bf.test/admin/displays/other/power/wake", { method: "POST" });
  assert.equal(response.status, 409);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.updates, []);
});


test("power routes wait for confirmed dispatch before changing state or emitting events", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const target of ["displays/display", "kiosks/kiosk"]) {
    for (const confirmed of [false, true]) {
      const f = fixture(["android-viewer", "android-standby-v1"], true);
      let finish!: (value: boolean) => void;
      const pending = new Promise<boolean>((resolve) => { finish = resolve; });
      let entered!: () => void;
      const dispatched = new Promise<void>((resolve) => { entered = resolve; });
      setCoordinator({ ...getCoordinator(), sendPowerToKiosk: async () => { entered(); return pending; } });
      const request = f.app.request(`http://bf.test/admin/${target}/power/standby`, { method: "POST" });
      await dispatched;
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.audits, []);
      finish(confirmed);
      assert.equal((await request).status, confirmed ? 302 : 409);
      assert.equal(f.updates.length, confirmed ? 1 : 0);
      assert.equal(f.events.length, confirmed ? 1 : 0);
      assert.equal(f.audits.length, confirmed && target.startsWith("kiosks") ? 1 : 0);
    }
  }
});


test("kiosk power reports the delivered target when assignment changes during dispatch", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const capabilities of [["android-viewer", "android-standby-v1"], ["windows"]]) {
    for (const command of ["standby", "wake"]) {
      const f = fixture(capabilities, true);
      let finish!: (value: boolean) => void;
      const pending = new Promise<boolean>((resolve) => { finish = resolve; });
      let entered!: () => void;
      const dispatched = new Promise<void>((resolve) => { entered = resolve; });
      setCoordinator({ ...getCoordinator(), sendPowerToKiosk: async (_id, message) => {
        if (capabilities.includes("android-viewer")) assert.deepEqual(message, { type: command, display_id: "display" });
        entered(); return pending;
      } });
      const request = f.app.request(`http://bf.test/admin/kiosks/kiosk/power/${command}`, { method: "POST" });
      await dispatched;
      // The command has been submitted for the original display; a later read
      // would now select a display that never received it.
      f.displays.splice(0, f.displays.length, { ...f.displays[0]!, id: "replacement" });
      finish(true);
      assert.equal((await request).status, 302);
      assert.deepEqual(f.updates.map((update) => update.id), ["display"]);
      assert.equal((f.events[0]?.[1] as { display_id: string }).display_id, "display");
      assert.equal(f.audits.length, 1);
    }
  }
});
