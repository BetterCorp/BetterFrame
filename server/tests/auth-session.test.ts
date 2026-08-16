import assert from "node:assert/strict";
import test from "node:test";

import { createAuth } from "../src/shared/auth.js";
import type { Session, Tenant, User } from "../src/shared/types.js";

test("session cookie is bound to its origin tenant", async () => {
  const tenant: Tenant = {
    id: "tenant-a",
    name: "Tenant A",
    slug: "tenant-a",
    schema_name: "tenant_a",
    is_active: true,
    max_kiosks: null,
    max_cameras: null,
    max_users: null,
    created_at: new Date(0).toISOString(),
  };
  const user: User = {
    id: "user-a",
    username: "admin",
    password_hash: "unused",
    role: "admin",
    is_active: true,
    totp_enabled: false,
    totp_secret_encrypted: null,
    recovery_codes_hashed: [],
    must_change_password: false,
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date(0).toISOString(),
  };
  const sessions = new Map<string, Session>();
  let currentSchema = "tenant_b";
  const repo = {
    adapter: { setSearchPath: async (schema: string) => { currentSchema = schema; } },
    createSession: async (input: Session) => {
      const session = {
        ...input,
        issued_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        revoked_at: null,
      } as Session;
      sessions.set(session.id, session);
      return session;
    },
    getTenantById: async (id: string) => id === tenant.id ? tenant : null,
    getSessionById: async (id: string) => sessions.get(id) ?? null,
    getUserById: async (id: string) => id === user.id ? user : null,
    touchSession: async () => {},
    revokeSession: async () => {},
  };
  const secrets = {
    deriveKey: () => Buffer.alloc(32, 7),
    encryptString: (value: string) => value,
    decryptString: (value: string) => value,
  };
  const auth = createAuth(repo as never, secrets as never, {
    sessionIdleSeconds: 3600,
    sessionMaxSeconds: 3600,
    loginLockoutThreshold: 8,
    loginLockoutSeconds: 60,
    argon2Memory: 8,
    argon2TimeCost: 1,
    argon2Parallelism: 1,
    totpIssuer: "BetterFrame",
    cookieName: "betterframe_session",
  });

  const created = await auth.createSession({
    user,
    originTenantId: tenant.id,
    userAgent: null,
    ipAddress: null,
    totpPending: false,
  });
  const resolved = await auth.resolveSession(created.cookieValue);

  assert.equal(resolved?.tenant.id, tenant.id);
  assert.equal(currentSchema, tenant.schema_name);
  assert.equal(await auth.resolveSession(created.cookieValue.replace("tenant-a", "tenant-b")), null);
  assert.equal(await auth.resolveSession(created.cookieValue.split(".").slice(1).join(".")), null);
});
