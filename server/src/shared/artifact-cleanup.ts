/**
 * Periodic cleanup of firmware + OS update artifact files.
 *
 * Strategy:
 * 1. Delete artifact files for yanked releases (DB row kept for audit).
 * 2. For each channel, keep only the N most recent non-yanked releases.
 *    Older ones are yanked + artifact deleted.
 *
 * Runs every 6 hours. Safe to call concurrently — worst case is two passes
 * trying to delete the same file (ENOENT is swallowed).
 */
import { unlink } from "node:fs/promises";
import type { Repository } from "../plugins/service-store/repository.js";

interface CleanupLog {
  info(msg: string): void;
  warn(msg: string): void;
}

const KEEP_PER_CHANNEL = 5;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function cleanupFirmware(repo: Repository, log: CleanupLog): Promise<number> {
  let cleaned = 0;

  const yanked = await repo.listYankedFirmwareReleases();
  for (const r of yanked) {
    if (await removeFile(r.artifact_path)) {
      log.info(`firmware cleanup: deleted artifact for yanked ${r.version} (${r.arch})`);
      cleaned++;
    }
    await repo.deleteFirmwareRelease(r.id);
  }

  const all = await repo.listFirmwareReleases();
  const active = all.filter((r) => !r.yanked_at);
  const byKey = new Map<string, typeof active>();
  for (const r of active) {
    const key = `${r.channel}:${r.arch}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  for (const [, releases] of byKey) {
    releases.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    const excess = releases.slice(KEEP_PER_CHANNEL);
    for (const r of excess) {
      if (await removeFile(r.artifact_path)) {
        log.info(`firmware cleanup: pruned old ${r.version} (${r.arch})`);
        cleaned++;
      }
      await repo.deleteFirmwareRelease(r.id);
    }
  }

  return cleaned;
}

async function cleanupOsUpdates(repo: Repository, log: CleanupLog): Promise<number> {
  let cleaned = 0;

  const yanked = await repo.listYankedOsUpdateReleases();
  for (const r of yanked) {
    if (await removeFile(r.artifact_path)) {
      log.info(`os-update cleanup: deleted artifact for yanked ${r.version}`);
      cleaned++;
    }
    await repo.deleteOsUpdateRelease(r.id);
  }

  const all = await repo.listOsUpdateReleases();
  const active = all.filter((r) => !r.yanked_at);
  const byKey = new Map<string, typeof active>();
  for (const r of active) {
    const key = `${r.channel}:${r.compatibility}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  for (const [, releases] of byKey) {
    releases.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    const excess = releases.slice(KEEP_PER_CHANNEL);
    for (const r of excess) {
      if (await removeFile(r.artifact_path)) {
        log.info(`os-update cleanup: pruned old ${r.version}`);
        cleaned++;
      }
      await repo.deleteOsUpdateRelease(r.id);
    }
  }

  return cleaned;
}

export function startArtifactCleanup(
  repo: Repository,
  log: CleanupLog,
): { stop: () => void } {
  async function run() {
    try {
      const fw = await cleanupFirmware(repo, log);
      const os = await cleanupOsUpdates(repo, log);
      if (fw + os > 0) {
        log.info(`artifact cleanup: removed ${fw} firmware + ${os} OS artifacts`);
      }
    } catch (err) {
      log.warn(`artifact cleanup failed: ${(err as Error).message}`);
    }
  }

  void run();
  const timer = setInterval(() => void run(), INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
