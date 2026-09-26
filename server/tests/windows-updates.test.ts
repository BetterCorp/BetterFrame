import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsPush, windowsPushRequest, selectWindowsRelease } from "../src/shared/windows-updates.js";
import { isKnownFirmwareTarget, firmwareTargetLabel } from "../src/shared/firmware-targets.js";
import type { Repository } from "../src/shared/db/repository.js";
import type { Kiosk } from "../src/shared/types.js";

test("Windows is a distinct supported signed firmware target", () => {
  assert.equal(isKnownFirmwareTarget("windows-x64"), true);
  assert.equal(firmwareTargetLabel("windows-x64"), "Windows x64");
});
test("an admin push overrides only its exact version and unchanged policy until expiry", () => {
  const policy = {channel:"stable",pin:null,schedule:{mode:"windows"}};
  const push = createWindowsPush("1.2.0", policy, 1000);
  assert.ok(windowsPushRequest(push,"1.2.0",policy,1001));
  assert.equal(windowsPushRequest(push,"1.3.0",policy,1001),null);
  assert.equal(windowsPushRequest(push,"1.2.0",{...policy,channel:"dev"},1001),null);
  assert.equal(windowsPushRequest(push,"1.2.0",policy,1000+1800000),null);
  assert.equal(windowsPushRequest("corrupt","1.2.0",policy,1001),null);
});
test("missing or withdrawn Windows pins never fall through to a different release", async () => {
  let latestCalls=0;
  const repo = {
    adapter: { dialect: () => "sqlite" },
    getFirmwareReleaseByVersionArch: async () => null,
    getLatestFirmwareRelease: async () => {latestCalls++;return null;},
  } as unknown as Repository;
  const kiosk = {id:"kiosk",firmware_target_version:"1.0.0",firmware_channel:"stable"} as Kiosk;
  assert.equal(await selectWindowsRelease(repo,kiosk,null),null);
  assert.equal(latestCalls,0);
});
