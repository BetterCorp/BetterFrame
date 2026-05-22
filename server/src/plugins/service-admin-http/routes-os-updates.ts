/**
 * Admin OS-update routes — release upload (via CI URL pull), list page,
 * yank, per-kiosk channel/pin, and rollouts. Mirrors routes-firmware.ts
 * structure for RAUC bundles.
 */
import { type H3, getRouterParam, readBody, createError } from "h3";
import { randomUUID } from "node:crypto";

import { htmlPage, htmlFragment } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import {
  OsUpdatePage,
  OsUpdateRolloutsPage,
  KioskOsUpdatePanel,
} from "../../web-templates/admin-pages.js";
import type { FirmwareChannel } from "../../shared/types.js";
import { audit } from "../../shared/audit.js";

const ALLOWED_CHANNELS: ReadonlySet<FirmwareChannel> = new Set(["stable", "beta", "dev"]);

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function registerOsUpdateRoutes(app: H3, deps: AdminDeps): void {
  // ---- List page -----------------------------------------------------------
  app.get("/admin/os-updates", (event) => {
    const user = event.context.user!;
    const releases = deps.repo.listOsUpdateReleases();
    return htmlPage(OsUpdatePage({ user: user.username, releases }));
  });

  // ---- Yank ---------------------------------------------------------------
  app.post("/admin/os-updates/:id/yank", (event) => {
    const id = String(getRouterParam(event, "id"));
    deps.repo.yankOsUpdateRelease(id);
    audit(deps.repo, event as any, "os_update.yank", {
      resource_type: "os_update_release",
      resource_id: id,
    });
    return new Response(null, { status: 302, headers: { location: "/admin/os-updates" } });
  });

  // ---- Per-kiosk OS-update settings ---------------------------------------
  app.post("/admin/kiosks/:id/os-update", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const channelRaw = (body?.["channel"] ?? "stable").trim() as FirmwareChannel;
    const targetRaw = (body?.["target_version"] ?? "").trim();
    if (!ALLOWED_CHANNELS.has(channelRaw)) {
      throw createError({ statusCode: 400, statusMessage: "invalid channel" });
    }
    deps.repo.setKioskOsUpdatePref(id, {
      channel: channelRaw,
      target_version: targetRaw ? targetRaw : null,
    });
    const k = deps.repo.getKioskById(id);
    if (!k) {
      return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    }
    const releases = deps.repo.listOsUpdateReleases();
    return htmlFragment(KioskOsUpdatePanel({ kiosk: k, releases }));
  });

  // Push OS update now: server pings the kiosk via WS coordinator.
  app.post("/admin/kiosks/:id/os-update/push", (event) => {
    const id = Number(getRouterParam(event, "id"));
    const { getCoordinator } = require("../../shared/coordinator-registry.js");
    const dispatched = getCoordinator().sendToKiosk(id, { type: "os_check" });
    return { ok: true, dispatched };
  });

  // ---- Rollouts -----------------------------------------------------------
  app.get("/admin/os-updates/rollouts", (event) => {
    const user = event.context.user!;
    const rollouts = deps.repo.listOsUpdateRollouts();
    const releases = deps.repo.listOsUpdateReleases();
    const kiosks = deps.repo.listKiosks();
    return htmlPage(OsUpdateRolloutsPage({
      user: user.username,
      rollouts,
      releases,
      kiosks,
    }));
  });

  app.post("/admin/os-updates/rollouts/new", async (event) => {
    const body = await readBody<Record<string, string | string[]>>(event);
    const releaseId = String(body?.["release_id"] ?? "");
    if (!releaseId) throw createError({ statusCode: 400, statusMessage: "release_id required" });
    const release = deps.repo.getOsUpdateRelease(releaseId);
    if (!release) throw createError({ statusCode: 404, statusMessage: "release not found" });
    const percentage = clamp(Number(body?.["percentage"] ?? 100), 1, 100);
    const targetsRaw = body?.["target_kiosk_ids"];
    const targets: number[] = Array.isArray(targetsRaw)
      ? targetsRaw.map((s) => Number(s)).filter((n) => Number.isFinite(n))
      : typeof targetsRaw === "string" && targetsRaw
        ? targetsRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
        : [];
    const user = event.context.user!;
    const rollout = deps.repo.createOsUpdateRollout({
      id: randomUUID(),
      release_id: releaseId,
      target_kiosk_ids: targets,
      percentage,
      created_by: user.id ?? null,
    });
    deps.repo.updateOsUpdateRolloutState(rollout.id, "active");
    audit(deps.repo, event as any, "os_update.rollout.create", {
      resource_type: "os_update_rollout",
      resource_id: rollout.id,
      metadata: { release_id: releaseId, percentage, target_count: targets.length },
    });
    return new Response(null, { status: 302, headers: { location: "/admin/os-updates/rollouts" } });
  });

  app.post("/admin/os-updates/rollouts/:id/state", async (event) => {
    const id = String(getRouterParam(event, "id"));
    const body = await readBody<{ state: string }>(event);
    const state = body?.state;
    if (state !== "paused" && state !== "active" && state !== "complete") {
      throw createError({ statusCode: 400, statusMessage: "invalid state" });
    }
    deps.repo.updateOsUpdateRolloutState(id, state);
    return new Response(null, { status: 302, headers: { location: "/admin/os-updates/rollouts" } });
  });

  // ---- CI auto-import (URL-based) -----------------------------------------
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
