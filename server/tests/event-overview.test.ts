import assert from "node:assert/strict";
import test from "node:test";

import { OverviewPage } from "../src/web-templates/admin-pages.js";

test("recent events link named sources and expose full details", () => {
  const html = String(OverviewPage({
    user: "admin",
    cameraCount: 1,
    kioskCount: 1,
    onlineKioskCount: 1,
    layoutCount: 1,
    events: [{
      id: "event-1",
      source_kiosk_id: "kiosk-1",
      source_camera_id: "camera-1",
      source_iobox_id: null,
      ingress_path: "/api/kiosk/event",
      source_type: "onvif",
      topic: "motion",
      property_op: "Changed",
      payload: { active: true },
      received_at: "2026-09-02T12:00:00.000Z",
      forwarded_to_nodered: true,
    }],
    cameraNames: new Map([["camera-1", "Front Door"]]),
    kioskNames: new Map([["kiosk-1", "Reception"]]),
    ioBoxNames: new Map(),
  }));

  assert.match(html, /href="\/admin\/cameras\/camera-1">Front Door<\/a>/);
  assert.match(html, /href="\/admin\/kiosks\/kiosk-1">Reception<\/a>/);
  assert.match(html, /<code>\/api\/kiosk\/event<\/code>/);
  assert.match(html, /active/);
  assert.match(html, /true/);
  assert.match(html, /showModal\(\)/);
});
