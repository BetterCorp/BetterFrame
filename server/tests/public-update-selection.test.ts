import assert from "node:assert/strict";
import test from "node:test";
import { selectPublicUpdate } from "../src/shared/public-update-selection.js";
import { updateScheduleAllowsNow } from "../src/shared/update-schedule.js";

test("public recovery honors saved channels and pins without falling through missing or yanked pins", async () => {
  const calls: string[] = [];
  const latest = async (channel: string) => { calls.push(channel); return { version: "3", yanked_at: null }; };
  const pinned = async (version: string) => version === "missing" ? null : { version, yanked_at: version === "yanked" ? "now" : null };
  assert.equal((await selectPublicUpdate(new URLSearchParams(), latest, pinned))?.version, "3");
  assert.deepEqual(calls, ["stable"]);
  await selectPublicUpdate(new URLSearchParams("channel=dev"), latest, pinned);
  assert.deepEqual(calls, ["stable", "dev"]);
  assert.equal((await selectPublicUpdate(new URLSearchParams("channel=beta&version=2"), latest, pinned))?.version, "2");
  assert.equal(await selectPublicUpdate(new URLSearchParams("version=missing"), latest, pinned), null);
  assert.equal(await selectPublicUpdate(new URLSearchParams("version=yanked"), latest, pinned), null);
  assert.equal(await selectPublicUpdate(new URLSearchParams("channel=invalid"), latest, pinned), null);
  assert.deepEqual(calls, ["stable", "dev"]);
});

test("saved client schedule uses the same overnight and end-exclusive boundaries as the server", () => {
  const schedule = { mode: "windows" as const, windows: [{ day: 6, start: "23:00", end: "01:00" }] };
  // Local constructors deliberately match the server's local schedule timezone.
  assert.equal(updateScheduleAllowsNow(schedule, new Date(2026, 8, 26, 23, 0)), true);
  assert.equal(updateScheduleAllowsNow(schedule, new Date(2026, 8, 27, 0, 59)), true);
  assert.equal(updateScheduleAllowsNow(schedule, new Date(2026, 8, 27, 1, 0)), false);
});
