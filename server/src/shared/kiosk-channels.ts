import type { Kiosk, FirmwareChannel } from "./types.js";

type Channels = Pick<Kiosk, "managed_image" | "firmware_channel" | "os_update_channel">;

/** Full OS images deliver the app, so their OS channel owns both policies. */
export function effectiveFirmwareChannel(kiosk: Channels | null | undefined): FirmwareChannel {
  return (kiosk?.managed_image ? kiosk.os_update_channel : kiosk?.firmware_channel) ?? "stable";
}

export function kioskDebugEnabled(kiosk: Channels): boolean {
  return effectiveFirmwareChannel(kiosk) === "dev" && kiosk.os_update_channel === "dev";
}

export function kioskDebugRequirement(kiosk: Channels): string {
  return kiosk.managed_image
    ? "Set OS channel to 'dev' to enable remote debug; the app channel follows the OS."
    : "Set firmware and OS channels to 'dev' to enable remote debug.";
}
