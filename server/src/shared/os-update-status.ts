import type { Kiosk } from "./types.js";
import { isVersionUpgrade } from "./version.js";

export type OsUpdateReport = { version: string; state: Kiosk["os_update_state"]; error: string | null };
type Previous = Pick<Kiosk, "os_update_last_attempt_version" | "os_update_state" | "os_update_last_error">;

/** Legacy clients may confirm the running slot while another slot is awaiting reboot.
 * That is not proof of rollback. Keep the target until a matching confirmation or
 * an explicit rollback report arrives. */
export function reconcileOsUpdateReport(previous: Previous, report: OsUpdateReport): OsUpdateReport | null {
  const target = previous.os_update_last_attempt_version;
  if (!target) return report;
  const state = previous.os_update_state;
  if (report.version !== target) {
    if (report.state === "confirmed" && ["installed", "pending_reboot", "failed", "rolled_back"].includes(state)) {
      if (isVersionUpgrade(report.version, target)) return report;
      if (previous.os_update_last_error) return null;
      return {
        version: target, state,
        error: `Running OS ${report.version} has not confirmed update ${target}. Awaiting the device's update result.`,
      };
    }
    // A delayed report for an older release must not erase a newer attempt/result.
    if (isVersionUpgrade(target, report.version)) return null;
  } else if (state === "confirmed" && report.state !== "confirmed" && report.state !== "rolled_back") {
    // A late install/failure response cannot undo confirmation of this same release.
    // Explicit rollback is different: a later boot may fall back after confirmation.
    return null;
  }
  if (report.version === target && report.state === state && report.error === previous.os_update_last_error) return null;
  return report;
}
