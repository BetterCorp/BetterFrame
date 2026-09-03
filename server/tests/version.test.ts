import assert from "node:assert/strict";
import test from "node:test";

import { isVersionUpgrade } from "../src/shared/version.js";

test("updates never downgrade a known installed version", () => {
  assert.equal(isVersionUpgrade("0.0.315", "0.0.316-dev.2ecd44b"), false);
  assert.equal(isVersionUpgrade("0.0.316-dev.2ecd44b", "0.0.316-dev.2ecd44b"), false);
  assert.equal(isVersionUpgrade("0.0.316-dev.2ecd44b", "0.0.316"), false);
  assert.equal(isVersionUpgrade("0.0.316", "0.0.316-dev.2ecd44b"), true);
  assert.equal(isVersionUpgrade("0.0.317-dev.1", "0.0.316"), true);
  assert.equal(isVersionUpgrade("0.0.317", ""), true);
  assert.equal(isVersionUpgrade("not-a-version", "0.0.316"), false);
});
