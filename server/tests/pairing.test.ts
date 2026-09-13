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

test("claim reports expiry, corrupt envelopes and missing sessions explicitly", async () => {
  const pc = { expires_at: new Date(Date.now() - 1000).toISOString(), consumed_at: null, extras: {} };
  const repo = { getPairingCode: async () => pc };
  assert.equal((await claimPairing(repo as never, "ABCDEFGH", {} as never)).status, "expired");
  pc.expires_at = new Date(Date.now() + 60_000).toISOString();
  Object.assign(pc, { consumed_at: new Date().toISOString(), extras: { pairing_claim_encrypted: "corrupt" } });
  assert.equal((await claimPairing(repo as never, "ABCDEFGH", { decryptString: () => { throw Error("corrupt"); } } as never)).status, "failed");
  assert.equal((await claimPairing({ getPairingCode: async () => null } as never, "ABCDEFGH", {} as never)).status, "expired");
});

test("confirmed claim uses delivery grace instead of the original code deadline", async () => {
  const repo = {
    getPairingCode: async () => ({
      expires_at: new Date(Date.now() - 1000).toISOString(), consumed_at: new Date().toISOString(), consumed_by_kiosk_id: "kiosk-1",
      extras: { claim_expires_at: new Date(Date.now() + 60_000).toISOString(), pairing_claim_encrypted: "envelope" },
    }),
    adapter: { withSearchPath: async (_s: string, fn: () => unknown) => fn() },
    getKioskById: async () => ({ name: "Lobby" }),
  };
  assert.equal((await claimPairing(repo as never, "ABCDEFGH", { decryptString: () => '{"kioskKey":"key"}' } as never)).status, "claimed");
});
