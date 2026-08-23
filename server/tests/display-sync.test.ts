import assert from "node:assert/strict";
import test from "node:test";

import { findReportedDisplayMatch } from "../src/plugins/service-api-http/index.js";

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
