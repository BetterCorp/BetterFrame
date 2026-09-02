import assert from "node:assert/strict";
import test from "node:test";

import { findReportedDisplayMatch } from "../src/plugins/service-api-http/index.js";
import { HeartbeatBody } from "../src/shared/api-schemas.js";

test("one stored display cannot satisfy two display reports", () => {
  const displays = [
    { id: "one", name: "Kiosk: \\\\.\\DISPLAY1", index: 0 },
  ];
  const seen = new Set<string>();

  const first = findReportedDisplayMatch(displays, seen, "\\\\.\\DISPLAY2", 0);
  assert.equal(first?.id, "one");
  seen.add(first!.id);

  assert.equal(findReportedDisplayMatch(displays, seen, "\\\\.\\DISPLAY1", 1), undefined);
});

test("heartbeat accepts clients that omit unavailable telemetry", () => {
  const result = HeartbeatBody.safeParse({
    bundle_version: null,
    kiosk_app_version: "0.1.0",
    firmware_target: "windows-x64",
    os_version: "windows",
    os_update_compatibility: "windows-desktop",
    displays: [
      { index: 0, name: "\\\\.\\DISPLAY1", width_px: 1024, height_px: 768, power_state: "awake" },
      { index: 1, name: "\\\\.\\DISPLAY10", width_px: 1920, height_px: 1080, power_state: "awake" },
    ],
    reported_hostname: "betterframe-test",
    network_interfaces: [],
    managed_config_applied_version: 0,
    managed_config_error: null,
  });

  assert.equal(result.success, true);
});
