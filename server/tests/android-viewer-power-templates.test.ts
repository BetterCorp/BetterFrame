import assert from "node:assert/strict";
import test from "node:test";
import { DisplayEditPage, KioskEditPage } from "../src/web-templates/admin-pages.js";
import type { Display, Kiosk, Layout } from "../src/shared/types.js";

const display = {
  id: "display-1", name: "Main", kiosk_id: "kiosk-1", index: 0,
  width_px: 1920, height_px: 1080, actual_power_state: "awake",
  active_layout_id: "layout-1", is_enabled: true,
} as Display;
const layout = { id: "layout-1", name: "Cameras" } as Layout;

for (const capabilities of [["android-viewer"], ["android-viewer", "android-standby-v1"], ["linux"], ["windows"]]) {
  const viewer = capabilities.includes("android-viewer");
  test(`${capabilities.join("+")} kiosk and display pages expose only supported hardware controls`, () => {
    const kiosk = { id: "kiosk-1", name: "Lobby", enabled: true, capabilities, cpu_temp_c: 42.5 } as Kiosk;
    const kioskHtml = String(KioskEditPage({
      user: "admin", kiosk, labels: [], allLabels: [],
      displayLayouts: [{ display, layouts: [layout] }],
    }));
    const displayHtml = String(DisplayEditPage({
      user: "admin", display, kiosk, kioskName: kiosk.name,
      attachedLayouts: [layout], availableLayouts: [],
    }));

    for (const action of ["reboot", "volume"]) {
      const endpoint = new RegExp(`/admin/kiosks/kiosk-1/${action}`);
      if (viewer) assert.doesNotMatch(kioskHtml, endpoint);
      else assert.match(kioskHtml, endpoint);
    }
    for (const action of ["apply", "save_default"]) {
      const submitButton = new RegExp(`name="action" value="${action}"`);
      if (viewer) assert.doesNotMatch(kioskHtml, submitButton);
      else assert.match(kioskHtml, submitButton);
    }
    for (const action of ["mute", "unmute"]) {
      const command = new RegExp(`&quot;action&quot;:&quot;${action}&quot;`);
      if (viewer) assert.doesNotMatch(kioskHtml, command);
      else assert.match(kioskHtml, command);
    }
    assert.match(kioskHtml, /CPU: 42\.5°C/);

    for (const [html, resource] of [[kioskHtml, "kiosks/kiosk-1"], [displayHtml, "displays/display-1"]] as const) {
      for (const action of ["wake", "standby"]) {
        const endpoint = new RegExp(`/admin/${resource}/power/${action}`);
        if (viewer && !capabilities.includes("android-standby-v1")) assert.doesNotMatch(html, endpoint);
        else assert.match(html, endpoint);
      }
      // Removing unsupported power buttons must leave the viewer's layout switch available.
      assert.match(html, /hx-post="\/admin\/displays\/display-1\/layout"/);
    }
  });
}
