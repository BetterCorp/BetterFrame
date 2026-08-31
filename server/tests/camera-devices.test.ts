import assert from "node:assert/strict";
import test from "node:test";

import { deviceGridPositions } from "../src/plugins/service-admin-http/routes-admin.js";
import { renderKioskLabels } from "../src/web-templates/admin-pages.js";

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

test("kiosk label picker keeps labels available for a second role", () => {
  const html = String(renderKioskLabels(
    "kiosk-1",
    [{ label_id: "label-1", name: "site-a", role: "consume" }],
    [{ id: "label-1", name: "site-a" } as never],
  ));
  assert.match(html, /<option value="label-1">site-a<\/option>/);
  assert.match(html, /&quot;role&quot;:&quot;consume&quot;/);
});
