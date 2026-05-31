export const FIRMWARE_TARGET_RPI5 = "betterframe-rpi5-aarch64";
export const FIRMWARE_TARGET_PC_X86_64 = "betterframe-pc-x86_64";

export function normalizeFirmwareTarget(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  switch (value) {
    case "aarch64-unknown-linux-gnu":
    case FIRMWARE_TARGET_RPI5:
      return FIRMWARE_TARGET_RPI5;
    case "x86_64-unknown-linux-gnu":
    case FIRMWARE_TARGET_PC_X86_64:
      return FIRMWARE_TARGET_PC_X86_64;
    default:
      return value;
  }
}

export function firmwareTargetLabel(raw: string | null | undefined): string {
  const target = normalizeFirmwareTarget(raw);
  switch (target) {
    case FIRMWARE_TARGET_RPI5:
      return "Raspberry Pi 5";
    case FIRMWARE_TARGET_PC_X86_64:
      return "PC x86_64";
    case "":
      return "unknown";
    default:
      return target;
  }
}

export function isKnownFirmwareTarget(raw: string | null | undefined): boolean {
  const target = normalizeFirmwareTarget(raw);
  return target === FIRMWARE_TARGET_RPI5 || target === FIRMWARE_TARGET_PC_X86_64;
}
