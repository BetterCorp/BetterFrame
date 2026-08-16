import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SecretsApi } from "./secrets.js";

export function createOnvifCallbackToken(
  secrets: SecretsApi,
  cameraId: string,
  nonce = randomBytes(18).toString("base64url"),
): { nonce: string; token: string; hash: string } {
  const token = createHmac("sha256", secrets.deriveKey("onvif-callback"))
    .update(`${cameraId}.${nonce}`)
    .digest("base64url");
  return { nonce, token, hash: hashOnvifCallbackToken(token) };
}

export function hashOnvifCallbackToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function onvifCallbackTokenMatches(token: string, expectedHash: string | null): boolean {
  if (!token || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashOnvifCallbackToken(token), "hex");
  return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}
