/**
 * Auth — shared module (not a BSB plugin).
 *
 * createAuth(repo, secrets, config) → AuthApi
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { TOTP, Secret } from "otpauth";

import type { Repository } from "./db/repository.js";
import type { SecretsApi } from "./secrets.js";
import type { ApiKey, ApiKeyScope, Session, User } from "./types.js";

// ---- Public interface -------------------------------------------------------

export interface AuthConfig {
  sessionIdleSeconds: number;
  sessionMaxSeconds: number;
  loginLockoutThreshold: number;
  loginLockoutSeconds: number;
  argon2Memory: number;
  argon2TimeCost: number;
  argon2Parallelism: number;
  totpIssuer: string;
  cookieName: string;
}

export interface AuthApi {
  readonly config: AuthConfig;
  hashPassword(plain: string): Promise<string>;
  verifyPassword(plain: string, hash: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  generateTotpSecret(): string;
  totpProvisioningUri(username: string, secretBase32: string): string;
  verifyTotpCode(secretBase32: string, code: string): boolean;
  encryptTotpSecret(secret: string): string;
  decryptTotpSecret(ciphertext: string): string;
  generateRecoveryCodes(): string[];
  hashRecoveryCodes(codes: string[]): Promise<string[]>;
  consumeRecoveryCode(code: string, hashedCodes: string[]): Promise<{ ok: boolean; remaining: string[] }>;
  createSession(input: {
    user: User;
    userAgent: string | null;
    ipAddress: string | null;
    totpPending: boolean;
  }): Promise<{ session: Session; cookieValue: string }>;
  resolveSession(cookieValue: string): Promise<{ session: Session; user: User } | null>;
  revokeSession(sid: string): Promise<void>;
  createApiKey(input: {
    name: string;
    scopes: ApiKeyScope[];
    expiresAt: string | null;
  }): Promise<{ apiKey: ApiKey; plaintext: string }>;
  verifyApiKey(plaintext: string, ip: string | null): Promise<ApiKey | null>;
  verifyKioskKey(plaintext: string): Promise<{ id: string } | null>;
}

// ---- Constants --------------------------------------------------------------

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;

// ---- Factory ----------------------------------------------------------------

export function createAuth(
  repo: Repository,
  secrets: SecretsApi,
  config: AuthConfig,
): AuthApi {

  // ---- Passwords ------------------------------------------------------------

  async function hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: config.argon2Memory,
      timeCost: config.argon2TimeCost,
      parallelism: config.argon2Parallelism,
    });
  }

  async function verifyPassword(plain: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  function needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, {
      memoryCost: config.argon2Memory,
      timeCost: config.argon2TimeCost,
      parallelism: config.argon2Parallelism,
    });
  }

  // ---- TOTP -----------------------------------------------------------------

  function generateTotpSecret(): string {
    return new Secret({ size: 20 }).base32;
  }

  function totpProvisioningUri(username: string, secretBase32: string): string {
    const totp = new TOTP({
      issuer: config.totpIssuer,
      label: username,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secretBase32),
    });
    return totp.toString();
  }

  function verifyTotpCode(secretBase32: string, code: string): boolean {
    const totp = new TOTP({
      issuer: config.totpIssuer,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secretBase32),
    });
    return totp.validate({ token: code, window: 1 }) !== null;
  }

  function encryptTotpSecret(secret: string): string {
    return secrets.encryptString(secret, "totp");
  }

  function decryptTotpSecret(ciphertext: string): string {
    return secrets.decryptString(ciphertext, "totp");
  }

  // ---- Recovery codes -------------------------------------------------------

  function generateRecoveryCodes(): string[] {
    const out: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const chars: string[] = [];
      const buf = randomBytes(RECOVERY_CODE_LENGTH);
      for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
        chars.push(RECOVERY_ALPHABET[buf[j]! % RECOVERY_ALPHABET.length]!);
      }
      out.push(chars.join(""));
    }
    return out;
  }

  async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
    return Promise.all(codes.map((c) => hashPassword(c)));
  }

  async function consumeRecoveryCode(
    code: string,
    hashedCodes: string[],
  ): Promise<{ ok: boolean; remaining: string[] }> {
    const remaining: string[] = [];
    let consumed = false;
    for (const h of hashedCodes) {
      if (!consumed && (await verifyPassword(code, h))) {
        consumed = true;
        continue;
      }
      remaining.push(h);
    }
    return { ok: consumed, remaining };
  }

  // ---- Sessions -------------------------------------------------------------

  const cookieKey = secrets.deriveKey("cookie");

  function cookieMac(sid: string): string {
    return createHmac("sha256", cookieKey).update(sid).digest("hex");
  }

  function signCookie(sid: string): string {
    return `${sid}.${cookieMac(sid)}`;
  }

  function unsignCookie(cookieValue: string): string | null {
    const dot = cookieValue.indexOf(".");
    if (dot < 0) return null;
    const sid = cookieValue.slice(0, dot);
    const mac = cookieValue.slice(dot + 1);
    const expected = cookieMac(sid);
    const a = Buffer.from(mac, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? sid : null;
  }

  async function createSession(input: {
    user: User;
    userAgent: string | null;
    ipAddress: string | null;
    totpPending: boolean;
  }): Promise<{ session: Session; cookieValue: string }> {
    const id = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(
      Date.now() + config.sessionMaxSeconds * 1000,
    ).toISOString();
    const session = await repo.createSession({
      id,
      user_id: input.user.id,
      csrf_token: csrfToken,
      totp_pending: input.totpPending,
      user_agent: input.userAgent,
      ip_address: input.ipAddress,
      expires_at: expiresAt,
    });
    return { session, cookieValue: signCookie(id) };
  }

  async function resolveSession(
    cookieValue: string,
  ): Promise<{ session: Session; user: User } | null> {
    const sid = unsignCookie(cookieValue);
    if (!sid) return null;
    const session = await repo.getSessionById(sid);
    if (!session) return null;
    if (session.revoked_at) return null;
    const now = new Date();
    if (new Date(session.expires_at) <= now) return null;
    const idleMs = config.sessionIdleSeconds * 1000;
    if (now.getTime() - new Date(session.last_seen_at).getTime() > idleMs) {
      await repo.revokeSession(sid);
      return null;
    }
    const user = await repo.getUserById(session.user_id);
    if (!user || !user.is_active) return null;
    await repo.touchSession(sid, now.toISOString());
    return { session, user };
  }

  async function revokeSession(sid: string): Promise<void> {
    await repo.revokeSession(sid);
  }

  // ---- API keys -------------------------------------------------------------

  async function createApiKey(input: {
    name: string;
    scopes: ApiKeyScope[];
    expiresAt: string | null;
  }): Promise<{ apiKey: ApiKey; plaintext: string }> {
    const plaintext = `bf-${randomBytes(24).toString("base64url")}`;
    const keyHash = await hashPassword(plaintext);
    const keyPrefix = plaintext.slice(0, 8);
    const apiKey = await repo.createApiKey({
      name: input.name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      scopes: input.scopes,
      expires_at: input.expiresAt,
    });
    return { apiKey, plaintext };
  }

  async function verifyApiKey(plaintext: string, ip: string | null): Promise<ApiKey | null> {
    const prefix = plaintext.slice(0, 8);
    const candidates = await repo.listApiKeysByPrefix(prefix);
    for (const cand of candidates) {
      if (cand.revoked_at) continue;
      if (cand.expires_at && new Date(cand.expires_at) <= new Date()) continue;
      if (await verifyPassword(plaintext, cand.key_hash)) {
        await repo.touchApiKey(cand.id, ip);
        return cand;
      }
    }
    return null;
  }

  async function verifyKioskKey(plaintext: string): Promise<{ id: string } | null> {
    if (plaintext.length < 8) return null;
    const prefix = plaintext.slice(0, 8);
    const candidates = await repo.listKiosksByKeyPrefix(prefix);
    for (const cand of candidates) {
      if (await verifyPassword(plaintext, cand.key_hash)) {
        return { id: cand.id };
      }
    }
    return null;
  }

  // ---- Return ---------------------------------------------------------------

  return {
    config,
    hashPassword,
    verifyPassword,
    needsRehash,
    generateTotpSecret,
    totpProvisioningUri,
    verifyTotpCode,
    encryptTotpSecret,
    decryptTotpSecret,
    generateRecoveryCodes,
    hashRecoveryCodes,
    consumeRecoveryCode,
    createSession,
    resolveSession,
    revokeSession,
    createApiKey,
    verifyApiKey,
    verifyKioskKey,
  };
}
