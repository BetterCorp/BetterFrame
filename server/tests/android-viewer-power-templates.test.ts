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

for (const capabilities of [["android-viewer"], ["linux"], ["windows"]]) {
  const viewer = capabilities.includes("android-viewer");
  test(`${capabilities[0]} kiosk and display pages expose only supported power controls`, () => {
    const kiosk = { id: "kiosk-1", name: "Lobby", enabled: true, capabilities } as Kiosk;
    const kioskHtml = String(KioskEditPage({
      user: "admin", kiosk, labels: [], allLabels: [],
      displayLayouts: [{ display, layouts: [layout] }],
    }));
    const displayHtml = String(DisplayEditPage({
      user: "admin", display, kiosk, kioskName: kiosk.name,
      attachedLayouts: [layout], availableLayouts: [],
    }));

    for (const [html, resource] of [[kioskHtml, "kiosks/kiosk-1"], [displayHtml, "displays/display-1"]]) {
      for (const action of ["wake", "standby"]) {
        const endpoint = new RegExp(`/admin/${resource}/power/${action}`);
        if (viewer) assert.doesNotMatch(html, endpoint);
        else assert.match(html, endpoint);
      }
      // Removing unsupported power buttons must leave the viewer's layout switch available.
      assert.match(html, /hx-post="\/admin\/displays\/display-1\/layout"/);
    }
  });
}
