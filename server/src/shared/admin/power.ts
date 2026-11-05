import type { AdminDeps } from "../../plugins/service-admin-http/index.js";
import { getCoordinator } from "../coordinator-registry.js";
import { isAndroidViewer, supportsAndroidStandby } from "../android-viewer.js";
export async function sendPowerCommand(
  deps: Pick<AdminDeps, "repo" | "sandboxMode">,
  kioskId: string,
  state: "on" | "standby",
  displayId?: string,
): Promise<Response | { displayIds: string[] }> {
  if (deps.sandboxMode)
    return Response.json(
      { error: "Live device commands are disabled in this test deployment" },
      { status: 409 },
    );
  const kiosk = await deps.repo.getKioskById(kioskId);
  if (!kiosk) return Response.json({ error: "Kiosk not found" }, { status: 404 });
  if (isAndroidViewer(kiosk)) {
    if (!supportsAndroidStandby(kiosk))
      return Response.json({ error: "Update the Android viewer to enable standby/wake" }, { status: 409 });
    const displays = (await deps.repo.listDisplaysForKiosk(kioskId)).filter((display) => display.is_enabled);
    if (displays.length !== 1 || (displayId !== undefined && displayId !== displays[0]!.id)) {
      return Response.json(
        { error: "Power target is not the Android viewer's assigned display" },
        { status: 409 },
      );
    }
    displayId = displays[0]!.id;
  }
  if (!kiosk.enabled) return Response.json({ error: "Kiosk is disabled" }, { status: 409 });
  // Carry the command's targets through delivery. Re-reading assignment after
  // the write could report a power change for an untouched replacement display.
  const displayIds = displayId
    ? [displayId]
    : (await deps.repo.listDisplaysForKiosk(kioskId)).map((display) => display.id);
  const sent = await getCoordinator().sendPowerToKiosk(kioskId, {
    type: state === "on" ? "wake" : "standby",
    ...(displayId ? { display_id: displayId } : {}),
  });
  if (!sent) return Response.json({ error: "Power command could not be delivered" }, { status: 409 });
  return { displayIds };
}
