/**
 * Firmware signing + storage helpers.
 *
 * Server holds an Ed25519 keypair used to sign kiosk binaries during upload.
 * Kiosks verify the signature before swapping. The private key never leaves
 * the server. The public key is shipped to kiosks via the bundle response
 * (so it can rotate without re-pairing) AND embedded in the binary at build
 * time as a fallback for first-boot.
 *
 * Key file lives at `${dataDir}/firmware-signing.key` (private, 0600) and
 * `${dataDir}/firmware-signing.pub` (public, 0644). Both PEM-encoded.
 * If env var BF_FIRMWARE_SIGNING_KEY is set (PEM string), it overrides the
 * file — convenient for cloud deploys where the key comes from a secret
 * manager.
 *
 * Storage for the firmware blobs themselves is `${dataDir}/firmware/`, one
 * file per release, named `<sha256>.bin`. Hashing on insert dedupes binaries
 * across version/arch metadata changes.
 */
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile, readFile, unlink, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FirmwareKeyPair {
  privateKey: KeyObject;
  publicKeyPem: string;
}

export interface FirmwareApi {
  /** Base64url of Ed25519(sha256(bytes)). Returns `{sha256, signature}`. */
  signBlob(bytes: Buffer): { sha256: string; signature: string };
  /** Verify a signature against bytes. Used by tests + admin re-verify. */
  verifyBlob(bytes: Buffer, signature: string): boolean;
  /** PEM-encoded SPKI public key for export to kiosks/bundle. */
  publicKeyPem(): string;
  /** Persist an uploaded firmware blob to disk and return absolute path. */
  storeBlob(bytes: Buffer, sha256: string): Promise<string>;
  /** Read a stored firmware blob by absolute path (re-checks sha256). */
  readBlob(path: string, expectedSha256: string): Promise<Buffer>;
  /** Delete a stored firmware blob (yank cleanup). */
  removeBlob(path: string): Promise<void>;
  /** Directory holding all firmware blobs. */
  firmwareDir(): string;
}

export interface FirmwareConfig {
  /** Server data dir (same as secrets dataDir, typically /var/lib/betterframe). */
  dataDir: string;
}

export interface FirmwareLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export function initFirmware(config: FirmwareConfig, log: FirmwareLog): FirmwareApi {
  const keyDir = config.dataDir;
  const privPath = join(keyDir, "firmware-signing.key");
  const pubPath = join(keyDir, "firmware-signing.pub");
  const firmwareDir = join(config.dataDir, "firmware");

  if (!existsSync(firmwareDir)) {
    mkdirSync(firmwareDir, { recursive: true, mode: 0o755 });
  }

  let keyPair = loadOrCreateKeyPair(keyDir, privPath, pubPath, log);

  function signBlob(bytes: Buffer): { sha256: string; signature: string } {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Sign the sha256 hex digest rather than the raw bytes — smaller, faster
    // verify, and matches what we ship as the integrity metadata anyway.
    const sig = cryptoSign(null, Buffer.from(sha256, "utf8"), keyPair.privateKey);
    return { sha256, signature: sig.toString("base64url") };
  }

  function verifyBlob(bytes: Buffer, signature: string): boolean {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pub = createPublicKey(keyPair.publicKeyPem);
    return cryptoVerify(
      null,
      Buffer.from(sha256, "utf8"),
      pub,
      Buffer.from(signature, "base64url"),
    );
  }

  async function storeBlob(bytes: Buffer, sha256: string): Promise<string> {
    const path = join(firmwareDir, `${sha256}.bin`);
    // Atomic write: write to .tmp then rename. Avoids partial files if the
    // server is killed mid-upload.
    const tmp = `${path}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o644 });
    await rename(tmp, path);
    return path;
  }

  async function readBlob(path: string, expectedSha256: string): Promise<Buffer> {
    const buf = await readFile(path);
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== expectedSha256) {
      throw new Error(`firmware sha256 mismatch on ${path}: expected ${expectedSha256}, got ${got}`);
    }
    return buf;
  }

  async function removeBlob(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  return {
    signBlob,
    verifyBlob,
    publicKeyPem: () => keyPair.publicKeyPem,
    storeBlob,
    readBlob,
    removeBlob,
    firmwareDir: () => firmwareDir,
  };
}

function loadOrCreateKeyPair(
  keyDir: string,
  privPath: string,
  pubPath: string,
  log: FirmwareLog,
): FirmwareKeyPair {
  // Env override for cloud / k8s — full private key PEM in a single var.
  // Coolify / shell env vars frequently mangle newlines (escaped `\n` instead
  // of real LF, CRLF, or wrapping quotes). Try multiple normalisations before
  // giving up and falling through to the on-disk / generated path.
  const envKey = process.env["BF_FIRMWARE_SIGNING_KEY"];
  if (envKey && envKey.trim().length > 0) {
    const parsed = tryParsePrivateKey(envKey);
    if (parsed) {
      const pub = createPublicKey(parsed).export({ format: "pem", type: "spki" });
      log.info("firmware: signing key loaded from BF_FIRMWARE_SIGNING_KEY env");
      return { privateKey: parsed, publicKeyPem: String(pub) };
    }
    log.warn(
      "firmware: BF_FIRMWARE_SIGNING_KEY set but could not be parsed as PEM " +
        "(checked literal, unescaped \\n, CRLF→LF, base64-wrapped). Falling " +
        "back to on-disk key / fresh generation. Existing kiosks will need a " +
        "re-pair if the public key changes.",
    );
  }

  if (existsSync(privPath) && existsSync(pubPath)) {
    const priv = createPrivateKey({ key: readFileSync(privPath), format: "pem" });
    const pub = readFileSync(pubPath, "utf8");
    return { privateKey: priv, publicKeyPem: pub };
  }

  log.warn("firmware: generating new Ed25519 signing keypair (no existing key found)");
  if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true, mode: 0o755 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = String(privateKey.export({ format: "pem", type: "pkcs8" }));
  const pubPem = String(publicKey.export({ format: "pem", type: "spki" }));
  writeFileSync(privPath, privPem, { mode: 0o600 });
  writeFileSync(pubPath, pubPem, { mode: 0o644 });
  return { privateKey, publicKeyPem: pubPem };
}

/**
 * Try several normalisations of an env-supplied PEM string. Coolify / docker
 * compose env passing routinely strips real newlines or wraps in quotes.
 */
function tryParsePrivateKey(raw: string): KeyObject | null {
  const candidates: string[] = [];
  candidates.push(raw);
  // \n / \r\n escape sequences → real newlines.
  if (raw.includes("\\n")) {
    candidates.push(raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n"));
  }
  // CRLF → LF
  if (raw.includes("\r")) candidates.push(raw.replace(/\r\n?/g, "\n"));
  // Strip surrounding single / double quotes.
  const m = raw.match(/^["'](.*)["']$/s);
  if (m && m[1]) candidates.push(m[1]);
  // Base64-encoded entire PEM (some platforms recommend this for safety).
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw.trim())) {
    try {
      const decoded = Buffer.from(raw.trim(), "base64").toString("utf8");
      if (decoded.includes("BEGIN")) candidates.push(decoded);
    } catch { /* ignore */ }
  }
  // Recover from "BEGIN PRIVATE KEY-----<body>-----END PRIVATE KEY" with no
  // internal line breaks: re-inject 64-char-wide line breaks around the body.
  if (/-----BEGIN [^-]+-----.*-----END [^-]+-----/.test(raw) && !raw.includes("\n")) {
    const pemMatch = raw.match(/-----BEGIN ([^-]+)-----(.*)-----END \1-----/s);
    if (pemMatch) {
      const header = pemMatch[1]!;
      const body = pemMatch[2]!.replace(/\s+/g, "");
      const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
      candidates.push(`-----BEGIN ${header}-----\n${wrapped}\n-----END ${header}-----\n`);
    }
  }

  for (const c of candidates) {
    try {
      return createPrivateKey({ key: c, format: "pem" });
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Standalone verifier used by anyone with just the public key (kiosk-side
 * equivalent of `verifyBlob` lives in Rust — this is for server-side checks
 * during upload re-verification).
 */
export function verifyDetached(
  publicKeyPem: string,
  sha256: string,
  signature: string,
): boolean {
  const pub = createPublicKey(publicKeyPem);
  return cryptoVerify(
    null,
    Buffer.from(sha256, "utf8"),
    pub,
    Buffer.from(signature, "base64url"),
  );
}

// path helper export so admin routes can serve relative paths cleanly
export function blobFilenameFromHash(sha256: string): string {
  return `${sha256}.bin`;
}

export { dirname };
