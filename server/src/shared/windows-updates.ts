import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "./db/repository.js";
import type { Kiosk } from "./types.js";
import { withDefaultTenant } from "./default-tenant.js";
import { normalizeUpdateSchedule } from "./update-schedule.js";

export async function windowsUpdatePolicy(repo: Repository, kiosk: Kiosk) {
  return {
    server: "", // The updater binds this to its configured BF origin.
    schedule: { ...normalizeUpdateSchedule(await repo.getSetupExtra("update_schedule")), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    firmware_channel: kiosk.firmware_channel ?? "stable",
    firmware_target_version: kiosk.firmware_target_version ?? null,
    os_update_channel: "stable", os_update_target_version: null,
  };
}

export async function selectWindowsRelease(repo: Repository, kiosk: Kiosk, schema: string | null) {
  return withDefaultTenant(repo, schema, async () => {
    if (kiosk.firmware_target_version) {
      const release = await repo.getFirmwareReleaseByVersionArch(kiosk.firmware_target_version, "windows-x64");
      return release && !release.yanked_at ? release : null;
    }
    for (const rollout of await repo.listActiveRolloutsForKiosk(kiosk.id)) {
      const bucket = createHash("sha256").update(`${rollout.id}:${kiosk.id}`).digest().readUInt32BE(0) % 100;
      if (bucket >= rollout.percentage) continue;
      const release = await repo.getFirmwareRelease(rollout.release_id);
      if (release && !release.yanked_at && release.arch === "windows-x64") return release;
    }
    return repo.getLatestFirmwareRelease(kiosk.firmware_channel ?? "stable", "windows-x64");
  });
}

export function createWindowsPush(version: string, policy: unknown, now = Date.now()): string {
  return JSON.stringify({ id: randomUUID(), version, policy: JSON.stringify(policy), expires: now + 30 * 60 * 1000 });
}
export function windowsPushRequest(raw: string | null | undefined, version: string | undefined, policy: unknown, now = Date.now()): string | null {
  try {
    const request = JSON.parse(raw ?? "null");
    return request && typeof request.id === "string" && request.version === version
      && request.expires > now && request.policy === JSON.stringify(policy) ? request.id : null;
  } catch { return null; }
}
