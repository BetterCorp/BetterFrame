/**
 * OS update bundle storage helpers.
 *
 * Full-device OTA uses RAUC bundles. Unlike the legacy app-binary updater,
 * bundle authenticity is verified by RAUC's X.509 keyring on the kiosk; the
 * server stores and serves metadata plus a sha256 integrity check.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface OsUpdateApi {
  osUpdateDir(): string;
  storeBuffer(bytes: Buffer, expectedSha256?: string | null): Promise<StoredOsBundle>;
  storeFromUrl(url: string, expectedSha256?: string | null): Promise<StoredOsBundle>;
  readBundle(path: string, expectedSha256: string): Promise<Buffer>;
  streamBundle(path: string): Promise<{ body: ReadableStream<Uint8Array>; size: number }>;
  removeBundle(path: string): Promise<void>;
}

export interface StoredOsBundle {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface OsUpdateConfig {
  dataDir: string;
}

export function initOsUpdates(config: OsUpdateConfig): OsUpdateApi {
  const osUpdateDir = join(config.dataDir, "os-updates");
  if (!existsSync(osUpdateDir)) {
    mkdirSync(osUpdateDir, { recursive: true, mode: 0o755 });
  }

  async function storeBuffer(bytes: Buffer, expectedSha256?: string | null): Promise<StoredOsBundle> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assertSha256(sha256, expectedSha256);
    const path = join(osUpdateDir, `${sha256}.raucb`);
    const tmp = `${path}.tmp`;
    await writeBufferAtomic(tmp, path, bytes);
    return { path, sha256, size_bytes: bytes.length };
  }

  async function storeFromUrl(url: string, expectedSha256?: string | null): Promise<StoredOsBundle> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("OS update source_url must use https");
    }

    const response = await fetch(parsed);
    if (!response.ok || !response.body) {
      throw new Error(`OS update source fetch failed: HTTP ${response.status}`);
    }

    const tmp = join(osUpdateDir, `download-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        hash.update(buf);
        callback(null, buf);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as any),
        meter,
        createWriteStream(tmp, { mode: 0o644 }),
      );
    } catch (err) {
      await removeIfExists(tmp);
      throw err;
    }

    const sha256 = hash.digest("hex");
    try {
      assertSha256(sha256, expectedSha256);
    } catch (err) {
      await removeIfExists(tmp);
      throw err;
    }
    const path = join(osUpdateDir, `${sha256}.raucb`);
    await rename(tmp, path);
    return { path, sha256, size_bytes: size };
  }

  async function readBundle(path: string, expectedSha256: string): Promise<Buffer> {
    const buf = await readFile(path);
    const got = createHash("sha256").update(buf).digest("hex");
    assertSha256(got, expectedSha256);
    return buf;
  }

  async function streamBundle(path: string): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    const size = (await stat(path)).size;
    return {
      body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
      size,
    };
  }

  return {
    osUpdateDir: () => osUpdateDir,
    storeBuffer,
    storeFromUrl,
    readBundle,
    streamBundle,
    removeBundle: removeIfExists,
  };
}

async function writeBufferAtomic(tmp: string, path: string, bytes: Buffer): Promise<void> {
  try {
    await writeFile(tmp, bytes, { mode: 0o644 });
    await rename(tmp, path);
  } catch (err) {
    await removeIfExists(tmp);
    throw err;
  }
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

function assertSha256(actual: string, expected?: string | null): void {
  if (!expected) return;
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error("expected sha256 must be 64 hex characters");
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`OS update sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}
