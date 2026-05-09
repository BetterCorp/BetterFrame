/**
 * service-secrets — symmetric crypto and the cluster key.
 *
 * Two roles:
 *   1. Field encryption for ONVIF passwords (and anything else stored
 *      sensitively at rest). Uses AES-256-GCM with a server-local key.
 *   2. Holding the cluster key (the shared symmetric secret kiosks use to
 *      decrypt the camera credentials in their bundle). Cluster key is
 *      generated at first-run setup and stored in setup_state.extras
 *      (server-encrypted).
 *
 * Server-local key sources (priority order):
 *   1. systemd-creds: $CREDENTIALS_DIRECTORY/betterframe-secret
 *   2. Dev fallback: <data_dir>/secret.key (chmod 0600). Generated if
 *      missing, with a WARN log so deploys notice.
 *
 * The cluster key never reaches disk in plaintext; it's encrypted with the
 * server-local key and stored in setup_state.extras["cluster_key_encrypted"].
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

import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";

// ---- Config -----------------------------------------------------------------

const ConfigSchema = av.object(
  {
    dataDir: av.string().minLength(1).default("/var/lib/betterframe"),
    /** Override the systemd-creds credential name. */
    systemdCredsName: av.string().default("betterframe-secret"),
  },
  { unknownKeys: "strip" },
);

export const Config = createConfigSchema(
  {
    name: "service-secrets",
    description:
      "Symmetric crypto for at-rest secrets and the inter-kiosk cluster key.",
    tags: ["service", "secrets", "crypto"],
  },
  ConfigSchema,
);

export const EventSchemas = createEventSchemas({
  emitEvents: {},
  onEvents: {},
  emitReturnableEvents: {},
  onReturnableEvents: {},
  emitBroadcast: {},
  onBroadcast: {},
});

// ---- Plugin -----------------------------------------------------------------

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  /** 32-byte server-local key. Used to wrap field secrets and the cluster key. */
  private serverKey?: Buffer;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    this.serverKey = this.loadServerKey(obs);
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {}

  // ---- public API for sibling services -------------------------------------

  /**
   * Encrypt a UTF-8 string at rest. Returns a self-describing ciphertext:
   *   v1.<iv-b64url>.<tag-b64url>.<ct-b64url>
   * `info` lets us domain-separate keys (e.g. "field" vs "cluster") so the
   * same server key can be used for distinct purposes safely.
   */
  encryptString(plaintext: string, info: string = "field"): string {
    const subkey = this.deriveSubkey(info);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", subkey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
  }

  decryptString(ciphertext: string, info: string = "field"): string {
    const parts = ciphertext.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") {
      throw new Error("ciphertext: bad format");
    }
    const iv = b64uDecode(parts[1]!);
    const tag = b64uDecode(parts[2]!);
    const ct = b64uDecode(parts[3]!);
    const subkey = this.deriveSubkey(info);
    const decipher = createDecipheriv("aes-256-gcm", subkey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  }

  /** Generate a fresh cluster key (32 bytes, base64url). */
  generateClusterKey(): string {
    return b64u(randomBytes(32));
  }

  /**
   * Encrypt-for-cluster: takes a plaintext + the cluster key, returns the
   * format the kiosk expects in its bundle. Symmetric counterpart in Rust.
   *
   *   v1.<iv-b64url>.<tag-b64url>.<ct-b64url>
   *
   * Same envelope shape as encryptString but keyed off the cluster key.
   */
  encryptForCluster(plaintext: string, clusterKeyB64u: string): string {
    const key = b64uDecode(clusterKeyB64u);
    if (key.length !== 32) throw new Error("cluster key must be 32 bytes");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
  }

  // ---- internals -----------------------------------------------------------

  private deriveSubkey(info: string): Buffer {
    if (!this.serverKey) throw new Error("service-secrets not initialized");
    // HKDF-SHA256 with the info string as the context.
    const out = hkdfSync(
      "sha256",
      this.serverKey,
      Buffer.alloc(0),
      Buffer.from(`betterframe.${info}`, "utf8"),
      32,
    );
    return Buffer.from(out);
  }

  private loadServerKey(obs: Observable): Buffer {
    // 1. systemd-creds
    const credsDir = process.env["CREDENTIALS_DIRECTORY"];
    if (credsDir) {
      const path = join(credsDir, this.config.systemdCredsName);
      if (existsSync(path)) {
        const buf = readFileSync(path);
        if (buf.length >= 32) {
          obs.log.info("server key loaded from systemd-creds");
          return buf.subarray(0, 32);
        }
        obs.log.warn(
          "systemd-creds file too short ({len}); falling back to dev key",
          { len: buf.length },
        );
      }
    }

    // 2. Dev fallback: <data_dir>/secret.key
    const path = join(this.config.dataDir, "secret.key");
    if (existsSync(path)) {
      const buf = readFileSync(path);
      if (buf.length >= 32) {
        obs.log.info("server key loaded from {path}", { path });
        return buf.subarray(0, 32);
      }
    }

    // 3. Generate new dev key
    obs.log.warn(
      "GENERATING DEV SERVER KEY at {path} — production deploys should use systemd-creds (CREDENTIALS_DIRECTORY/{name}) instead",
      { path, name: this.config.systemdCredsName },
    );
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* already exists or insufficient perms */
    }
    const fresh = randomBytes(32);
    writeFileSync(path, fresh, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* not POSIX; fine on dev */
    }
    return fresh;
  }
}

// ---- base64url helpers (no padding) ----------------------------------------

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
