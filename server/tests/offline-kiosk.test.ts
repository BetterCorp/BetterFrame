import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("kiosk boot and RAUC confirmation do not wait for network-online", () => {
  for (const file of [
    "../../deploy/systemd/betterframe-kiosk.service",
    "../../deploy/systemd/betterframe-rauc-mark-good.service",
  ]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /network-online\.target/);
  }
});
