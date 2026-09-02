/**
 * Symmetric crypto and cluster key — shared module (not a BSB plugin).
 *
 * initSecrets(config, log) → SecretsApi
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";

// ---- Public interface -------------------------------------------------------

export interface SecretsConfig {
  dataDir: string;
  systemdCredsName?: string;
  /** Systemd credentials directory (e.g. /run/credentials/betterframe.service). */
  systemdCredsDir?: string;
}

export interface SecretsLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export const CLUSTER_SECRET_CONTEXT = "cluster";

export interface SecretsApi {
  encryptString(plaintext: string, info?: string): string;
  decryptString(ciphertext: string, info?: string): string;
  deriveKey(info: string): Buffer;
  generateClusterKey(): string;
  encryptForCluster(plaintext: string, clusterKeyB64u: string): string;
}

// ---- Init -------------------------------------------------------------------

export function initSecrets(config: SecretsConfig, log: SecretsLog): SecretsApi {
  const serverKey = loadServerKey(config, log);

  function deriveSubkey(info: string): Buffer {
    const out = hkdfSync(
      "sha256",
      serverKey,
      Buffer.alloc(0),
      Buffer.from(`betterframe.${info}`, "utf8"),
      32,
    );
    return Buffer.from(out);
  }

  return {
    deriveKey(info: string): Buffer {
      return deriveSubkey(info);
    },

    encryptString(plaintext: string, info: string = "field"): string {
      const subkey = deriveSubkey(info);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", subkey, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
    },

    decryptString(ciphertext: string, info: string = "field"): string {
      const parts = ciphertext.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") {
        throw new Error("ciphertext: bad format");
      }
      const iv = b64uDecode(parts[1]!);
      const tag = b64uDecode(parts[2]!);
      const ct = b64uDecode(parts[3]!);
      const subkey = deriveSubkey(info);
      const decipher = createDecipheriv("aes-256-gcm", subkey, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString("utf8");
    },

    generateClusterKey(): string {
      return b64u(randomBytes(32));
    },

    encryptForCluster(plaintext: string, clusterKeyB64u: string): string {
      const key = b64uDecode(clusterKeyB64u);
      if (key.length !== 32) throw new Error("cluster key must be 32 bytes");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
    },
  };
}

// ---- Key loading ------------------------------------------------------------

function loadServerKey(config: SecretsConfig, log: SecretsLog): Buffer {
  const credsName = config.systemdCredsName ?? "betterframe-secret";

  // 1. systemd-creds
  const credsDir = config.systemdCredsDir;
  if (credsDir) {
    const p = join(credsDir, credsName);
    if (existsSync(p)) {
      const buf = readFileSync(p);
      if (buf.length >= 32) {
        log.info("server key loaded from systemd-creds");
        return buf.subarray(0, 32);
      }
      log.warn("systemd-creds file too short; falling back to dev key");
    }
  }

  // 2. Dev fallback
  const keyPath = join(config.dataDir, "secret.key");
  if (existsSync(keyPath)) {
    const buf = readFileSync(keyPath);
    if (buf.length >= 32) {
      log.info(`server key loaded from ${keyPath}`);
      return buf.subarray(0, 32);
    }
  }

  // 3. No key found — generate one and persist.
  log.info(
    `encryption key not found, generating new key at ${keyPath}`,
  );
  try {
    mkdirSync(dirname(keyPath), { recursive: true });
  } catch {
    /* exists or insufficient perms */
  }
  const fresh = randomBytes(32);
  writeFileSync(keyPath, fresh, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* not POSIX; fine on dev */
  }
  return fresh;
}

// ---- base64url helpers ------------------------------------------------------

function b64u(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64uDecode(s: string): Buffer {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
