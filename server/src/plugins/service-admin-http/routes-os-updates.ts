/**
 * Admin OS-update routes.
 *
 * Full OS OTA artifacts are RAUC `.raucb` bundles. CI imports by URL so large
 * bundles are streamed server-side instead of base64 encoded into JSON.
 */
import { type H3, readBody, createError } from "h3";
import { randomUUID } from "node:crypto";

import type { AdminDeps } from "./index.js";
import type { FirmwareChannel } from "../../shared/types.js";
import { audit } from "../../shared/audit.js";

const ALLOWED_CHANNELS: ReadonlySet<FirmwareChannel> = new Set(["stable", "beta", "dev"]);

export function registerOsUpdateRoutes(app: H3, deps: AdminDeps): void {
  app.post("/api/admin/os/import", async (event) => {
    const body = await readBody<{
      version: string;
      channel: FirmwareChannel;
      compatibility: string;
      release_notes?: string;
      source_url: string;
      sha256?: string;
    }>(event);

    const version = body?.version?.trim();
    const channel = body?.channel;
    const compatibility = body?.compatibility?.trim();
    const sourceUrl = body?.source_url?.trim();
    const expectedSha256 = body?.sha256?.trim() || null;

    if (!version || !channel || !compatibility || !sourceUrl) {
      throw createError({ statusCode: 400, statusMessage: "version, channel, compatibility, source_url required" });
    }
    if (!ALLOWED_CHANNELS.has(channel)) {
      throw createError({ statusCode: 400, statusMessage: `invalid channel '${channel}'` });
    }
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      throw createError({ statusCode: 400, statusMessage: `invalid version '${version}' (expected semver)` });
    }
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(compatibility)) {
      throw createError({ statusCode: 400, statusMessage: "invalid compatibility" });
    }

    let stored;
    try {
      stored = await deps.osUpdates.storeFromUrl(sourceUrl, expectedSha256);
    } catch (err) {
      throw createError({ statusCode: 400, statusMessage: (err as Error).message });
    }

    let release;
    try {
      release = deps.repo.createOsUpdateRelease({
        id: randomUUID(),
        version,
        channel,
        compatibility,
        artifact_path: stored.path,
        size_bytes: stored.size_bytes,
        sha256: stored.sha256,
        release_notes: body.release_notes ?? null,
        uploaded_by: event.context.user?.id || null,
      });
    } catch (err) {
      await deps.osUpdates.removeBundle(stored.path);
      throw createError({ statusCode: 409, statusMessage: (err as Error).message });
    }

    audit(deps.repo, event as any, "os_update.import", {
      resource_type: "os_update_release",
      resource_id: release.id,
      metadata: {
        version,
        channel,
        compatibility,
        sha256: stored.sha256,
        size: stored.size_bytes,
        source_url: sourceUrl,
      },
    });

    return {
      ok: true,
      release_id: release.id,
      sha256: stored.sha256,
      size_bytes: stored.size_bytes,
    };
  });
}
