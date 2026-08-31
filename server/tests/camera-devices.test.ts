import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraCapabilitiesFromForm,
  deviceGridPositions,
} from "../src/plugins/service-admin-http/routes-admin.js";
import {
  renderCameraDeviceLabels,
  renderCameraLabels,
  renderKioskLabels,
} from "../src/web-templates/admin-pages.js";

test("device cameras fill a compact grid in stable discovery order", () => {
  assert.deepEqual(deviceGridPositions(0), []);
  assert.deepEqual(deviceGridPositions(5), [
    { row: 0, col: 0 },
    { row: 0, col: 1 },
    { row: 0, col: 2 },
    { row: 1, col: 0 },
    { row: 1, col: 1 },
  ]);
});

test("camera PTZ checkbox preserves unrelated capabilities", () => {
  assert.deepEqual(cameraCapabilitiesFromForm(["events", "PTZ"], false), ["events"]);
  assert.deepEqual(cameraCapabilitiesFromForm(["events"], true), ["events", "ptz"]);
});

test("kiosk label picker keeps labels available for a second role", () => {
  const html = String(renderKioskLabels(
    "kiosk-1",
    [{ label_id: "label-1", name: "site-a", role: "consume" }],
    [{ id: "label-1", name: "site-a" } as never],
  ));
  assert.match(html, /<option value="label-1">site-a<\/option>/);
  assert.match(html, /&quot;role&quot;:&quot;consume&quot;/);
});

test("camera labels distinguish inherited device labels", () => {
  const labels = [
    { label_id: "device-label", name: "site-a", inherited: true },
    { label_id: "camera-label", name: "entrance", inherited: false },
  ];
  const html = String(renderCameraLabels("camera-1", labels, labels.map((label) => ({ id: label.label_id, name: label.name } as never))));

  assert.match(html, /site-a \(device\)/);
  assert.doesNotMatch(html, /device-label/);
  assert.match(html, /camera-label/);
  assert.match(String(renderCameraDeviceLabels("device-1", [], [])), /camera-devices\/device-1\/labels/);
});
