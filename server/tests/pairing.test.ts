import assert from "node:assert/strict";
import test from "node:test";
import { claimPairing } from "../src/shared/pairing.js";

test("a claimed pairing code can be retried until it expires", async () => {
  const pairingCode = {
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: new Date().toISOString(),
    consumed_by_kiosk_id: "kiosk-1",
    kiosk_proposed_name: "Lobby",
    extras: {
      pairing_claim_encrypted: "encrypted-test",
      tenant_schema: "public",
    },
  };
  const repo = {
    getPairingCode: async () => pairingCode,
    getKioskById: async () => ({ id: "kiosk-1", name: "Lobby" }),
    adapter: {
      withSearchPath: async (_schema: string, fn: () => unknown) => fn(),
    },
  };
  const secrets = {
    decryptString: () => JSON.stringify({
      kioskKey: "bf-test",
      clusterKey: "cluster-test",
      encryptKey: "encrypt-test",
    }),
  };

  const first = await claimPairing(repo as never, "ABCDEFGH", secrets as never);
  const retry = await claimPairing(repo as never, "ABCDEFGH", secrets as never);

  assert.deepEqual(retry, first);
  assert.equal(retry.kioskKey, "bf-test");
});
