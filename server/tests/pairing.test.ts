import assert from "node:assert/strict";
import test from "node:test";
import { claimPairing, confirmPairing } from "../src/shared/pairing.js";

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
  assert.equal(retry.encryptKey, "encrypt-test");
  assert.equal("clusterKey" in retry, false);
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

test("Android claims receive only their per-device encryption key", async () => {
  const repo = {
    getPairingCode: async () => ({
      expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: new Date().toISOString(), consumed_by_kiosk_id: "viewer",
      extras: { pairing_claim_encrypted: "envelope" },
    }),
    adapter: { withSearchPath: async (_s: string, fn: () => unknown) => fn() },
    getKioskById: async () => ({ name: "Viewer", capabilities: ["android-viewer"], enabled: true }),
  };
  const result = await claimPairing(repo as never, "ABCDEFGH", { decryptString: () => JSON.stringify({ kioskKey: "device-key", encryptKey: "device-encrypt", clusterKey: "shared-secret" }) } as never);
  assert.equal(result.status, "claimed");
  assert.equal(result.encryptKey, "device-encrypt");
  assert.equal("clusterKey" in result, false);
});
for (const legacyKey of [undefined, "unreadable-legacy-ciphertext"]) {
  test(`adoption and claim use only per-device keys with legacy key ${legacyKey ?? "absent"}`, async () => {
    const pc: any = {
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null, extras: {}, kiosk_capabilities: [], kiosk_proposed_name: "Lobby",
    };
    let storedKey: string | undefined;
    const repo = {
      adapter: { withSearchPath: async (_s: string, fn: () => unknown) => fn() },
      transact: async (fn: () => unknown) => fn(),
      getPairingCode: async () => pc,
      getSetupExtra: async () => { assert.fail(`must not read legacy key: ${legacyKey}`); },
      getKioskByName: async () => null,
      createKiosk: async () => ({ id: "kiosk-1", name: "Lobby" }),
      createDisplayForKiosk: async () => {},
      updateKiosk: async (_id: string, values: any) => { storedKey = values.encrypt_key_encrypted; },
      markPairingCodeClaimed: async (_code: string, id: string, extras: any) => {
        Object.assign(pc, { consumed_at: new Date().toISOString(), consumed_by_kiosk_id: id, extras });
      },
      getKioskById: async () => ({ id: "kiosk-1", name: "Lobby", enabled: true }),
    };
    const secrets = {
      encryptString: (value: string, context: string) => `${context}:${value}`,
      decryptString: (value: string, context: string) => {
        assert.notEqual(context, "cluster");
        assert.ok(value.startsWith(`${context}:`));
        return value.slice(context.length + 1);
      },
    };
    await confirmPairing(repo as never, { hashPassword: async () => "hash" } as never, secrets as never, { code: "ABCDEFGH" });
    const claim = await claimPairing(repo as never, "ABCDEFGH", secrets as never);
    assert.equal(claim.status, "claimed");
    assert.equal(Buffer.from(claim.encryptKey!, "base64url").length, 32);
    assert.equal(storedKey, `kiosk-encrypt:${claim.encryptKey}`);
    assert.equal("clusterKey" in claim, false);
    assert.equal("clusterKey" in JSON.parse(secrets.decryptString(pc.extras.pairing_claim_encrypted, "pairing-claim")), false);
  });
}
