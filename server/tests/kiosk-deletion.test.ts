import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import argon2 from "argon2";
import { registerViewerDeviceAuth } from "../src/shared/display-session.js";

// Exercise the wire contract used by already-installed Linux clients: a 200
// deletion marker on polling, then a separate 401 confirmation from _check.
test("deleted kiosk polling resets only after matching the deleted password hash", async () => {
  const deletedKey = "sameprefix-deleted-secret";
  const hash = await argon2.hash(deletedKey);
  const app = new H3();
  let lookups = 0;
  registerViewerDeviceAuth(app, {
    listDeletedKioskKeysByPrefix: async (prefix: string) => {
      lookups++;
      return prefix === deletedKey.slice(0, 8) ? [{ key_hash: hash }] : [];
    },
    adapter: { withSearchPath: async (_schema: string, fn: () => unknown) => fn() },
    getKioskById: async () => ({ id: "active", enabled: true }),
  } as never, {
    verifyKioskKey: async (key: string) => key === "active-device-key"
      ? { id: "active", schema_name: "public" } : null,
    verifyPassword: (key: string, stored: string) => argon2.verify(stored, key),
  } as never, {} as never);
  app.get("/api/kiosk/bundle", () => ({ active: true }));
  const request = (path: string, key?: string, method = "GET", cookie = false) => app.request(`http://bf.test/api/kiosk/${path}`, {
    method,
    headers: key ? cookie ? { cookie: `betterframe_kiosk_key=${key}` } : { authorization: `Bearer ${key}` } : {},
  });
  for (const [path, method] of [["bundle", "GET"], ["heartbeat", "POST"]]) {
    const response = await request(path!, deletedKey, method);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { bf_kiosk_deleted: true });
    assert.equal((await request(path!, "sameprefix-wrong-secret", method)).status, 401);
    assert.equal((await request(path!, "unknown-device-key", method)).status, 401);
    assert.equal((await request(path!, undefined, method)).status, 401);
    assert.equal((await request(path!, deletedKey, method, true)).status, 401);
  }
  const beforeCheck = lookups;
  assert.equal((await request("_check", deletedKey)).status, 401);
  assert.equal((await request("firmware/check", deletedKey)).status, 401);
  assert.equal(lookups, beforeCheck);
  const active = await request("bundle", "active-device-key");
  assert.equal(active.status, 200);
  assert.deepEqual(await active.json(), { active: true });
  assert.equal(lookups, beforeCheck);
});
