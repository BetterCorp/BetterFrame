import type { SecretsApi } from "../secrets.js";
export const CAMERA_CREDENTIAL_PREFIX = "bf-camera:";
export function encryptCameraCredential(secrets: Pick<SecretsApi, "encryptString">, value: string): string {
  return CAMERA_CREDENTIAL_PREFIX + secrets.encryptString(value, "camera-password");
}
