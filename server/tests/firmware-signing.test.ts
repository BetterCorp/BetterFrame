import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  normalizeFirmwareSignature,
  verifyClientFirmware,
} from "../src/plugins/service-admin-http/routes-firmware.js";
import type { AdminDeps } from "../src/plugins/service-admin-http/index.js";

test("client firmware imports require a vendor signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from("release artifact");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const signature = sign(null, Buffer.from(sha256), privateKey).toString("base64url");
  const deps = {
    clientFirmwarePublicKey: String(publicKey.export({ format: "pem", type: "spki" })),
  } as AdminDeps;

  assert.equal(verifyClientFirmware(deps, bytes, signature), sha256);
  assert.throws(() => verifyClientFirmware(deps, Buffer.from("tampered"), signature));
});

test("client firmware import rejects malformed signatures before verification", () => {
  assert.equal(normalizeFirmwareSignature(123), null);
  assert.equal(normalizeFirmwareSignature("   "), null);
  assert.equal(normalizeFirmwareSignature(" signed "), "signed");
});
