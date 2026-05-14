/**
 * Encrypted server backup / restore.
 *
 * Bundles the SQLite DB + master secret + firmware signing keypair into a
 * single `.bfbak` blob encrypted with AES-256-GCM. Key is derived from an
 * admin-supplied passphrase via PBKDF2(SHA-256, 200k iters).
 *
 *   format:  "bfbak1" || salt[32] || nonce[12] || ciphertext+tag
 *
 *   inner plaintext: JSON
 *     { version: 1,
 *       created_at: <iso>,
 *       files: { "betterframe.db": "<b64>", "secret.key": "<b64>", ... } }
 *
 * Firmware blobs (firmware/*.bin) are excluded — re-upload via the admin
 * Firmware page after restore. They can be GB-sized and would defeat the
 * point of a "small portable backup".
 */
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MAGIC = Buffer.from("bfbak1", "utf8"); // 6 bytes
const SALT_LEN = 32;
const NONCE_LEN = 12;
const PBKDF2_ITERS = 200_000;
const KEY_LEN = 32;

const BACKED_UP_FILES = [
  "betterframe.db",
  "secret.key",
  "firmware-signing.key",
  "firmware-signing.pub",
] as const;

export interface BackupResult {
  blob: Buffer;
  filename: string;
  fileCount: number;
}

export function createBackup(dataDir: string, passphrase: string): BackupResult {
  if (passphrase.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }

  const files: Record<string, string> = {};
  for (const name of BACKED_UP_FILES) {
    const path = join(dataDir, name);
    if (existsSync(path)) {
      files[name] = readFileSync(path).toString("base64");
    }
  }

  const inner = JSON.stringify({
    version: 1,
    created_at: new Date().toISOString(),
    files,
  });

  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERS, KEY_LEN, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.from(inner, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([MAGIC, salt, nonce, enc, tag]);
  return {
    blob,
    filename: `betterframe-${new Date().toISOString().replace(/[:.]/g, "-")}.bfbak`,
    fileCount: Object.keys(files).length,
  };
}

export function restoreBackup(dataDir: string, passphrase: string, blob: Buffer): {
  fileCount: number;
  files: string[];
} {
  if (blob.length < MAGIC.length + SALT_LEN + NONCE_LEN + 16) {
    throw new Error("backup file too short / corrupt");
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a bfbak file");
  }
  let off = MAGIC.length;
  const salt = blob.subarray(off, off + SALT_LEN);
  off += SALT_LEN;
  const nonce = blob.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const tag = blob.subarray(blob.length - 16);
  const enc = blob.subarray(off, blob.length - 16);

  const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERS, KEY_LEN, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  let dec: Buffer;
  try {
    dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    throw new Error("wrong passphrase or corrupted backup");
  }

  const inner = JSON.parse(dec.toString("utf8")) as {
    version: number;
    files: Record<string, string>;
  };
  if (inner.version !== 1) throw new Error(`unsupported backup version ${String(inner.version)}`);

  mkdirSync(dataDir, { recursive: true });
  const restored: string[] = [];
  for (const [name, b64] of Object.entries(inner.files)) {
    // Refuse path traversal in filenames.
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) continue;
    if (!(BACKED_UP_FILES as readonly string[]).includes(name)) continue;
    const target = join(dataDir, name);
    writeFileSync(target, Buffer.from(b64, "base64"), {
      mode: name.endsWith(".key") ? 0o600 : 0o644,
    });
    restored.push(name);
  }
  return { fileCount: restored.length, files: restored };
}
