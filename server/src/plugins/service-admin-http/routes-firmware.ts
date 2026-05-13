/**
 * Admin firmware routes — release upload, list, yank, per-kiosk push.
 *
 * Upload path supports:
 *   - browser multipart form ("upload from your machine")
 *   - CI auto-import via API key (header X-BetterFrame-API-Key: bf-…)
 *     POST /api/admin/firmware/import with JSON {version, channel, arch,
 *     signature, sha256, release_notes, content_b64} so GitHub Actions can
 *     publish releases without a session.
 */
import { type H3, getRouterParam, readBody, createError } from "h3";
import { randomUUID } from "node:crypto";

import { htmlPage, htmlFragment } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import {
  FirmwarePage,
  KioskFirmwarePanel,
} from "../../web-templates/admin-pages.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import type { FirmwareChannel } from "../../shared/types.js";

const ALLOWED_CHANNELS: ReadonlySet<FirmwareChannel> = new Set(["stable", "beta", "dev"]);
const ALLOWED_ARCHES = new Set([
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "armv7-unknown-linux-gnueabihf",
]);

export function registerFirmwareRoutes(app: H3, deps: AdminDeps): void {
  // ---- List page -----------------------------------------------------------
  app.get("/admin/firmware", (event) => {
    const user = event.context.user!;
    const releases = deps.repo.listFirmwareReleases();
    return htmlPage(FirmwarePage({
      user: user.username,
      releases,
      publicKeyPem: deps.firmware.publicKeyPem(),
    }));
  });

  // ---- Human upload (multipart) -------------------------------------------
  app.post("/admin/firmware/upload", async (event) => {
    const user = event.context.user!;
    const req = event.req;
    const form = await req.formData();
    const file = form.get("artifact");
    if (!(file instanceof File)) {
      throw createError({ statusCode: 400, statusMessage: "artifact file required" });
    }
    const version = String(form.get("version") ?? "").trim();
    const channelRaw = String(form.get("channel") ?? "stable").trim();
    const arch = String(form.get("arch") ?? "").trim();
    const releaseNotes = String(form.get("release_notes") ?? "").trim() || null;

    if (!ALLOWED_CHANNELS.has(channelRaw as FirmwareChannel)) {
      throw createError({ statusCode: 400, statusMessage: `invalid channel '${channelRaw}'` });
    }
    if (!ALLOWED_ARCHES.has(arch)) {
      throw createError({ statusCode: 400, statusMessage: `invalid arch '${arch}'` });
    }
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      throw createError({ statusCode: 400, statusMessage: `invalid version '${version}' (expected semver)` });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const { sha256, signature } = deps.firmware.signBlob(buf);
    const artifactPath = await deps.firmware.storeBlob(buf, sha256);

    deps.repo.createFirmwareRelease({
      id: randomUUID(),
      version,
      channel: channelRaw as FirmwareChannel,
      arch,
      artifact_path: artifactPath,
      size_bytes: buf.length,
      sha256,
      signature,
      release_notes: releaseNotes,
      uploaded_by: user.id,
    });

    return new Response(null, { status: 302, headers: { location: "/admin/firmware" } });
  });

  // ---- CI auto-import (JSON, API-key-auth) --------------------------------
  // Body: {version, channel, arch, release_notes?, content_b64}
  // Server signs server-side (no client-side trust required for signing key)
  app.post("/api/admin/firmware/import", async (event) => {
    // Middleware already verified API key on /api/admin/* — admin scope
    // checked there. No further auth needed here.
    const body = await readBody<{
      version: string;
      channel: FirmwareChannel;
      arch: string;
      release_notes?: string;
      content_b64: string;
    }>(event);

    if (!body?.version || !body.channel || !body.arch || !body.content_b64) {
      throw createError({ statusCode: 400, statusMessage: "version, channel, arch, content_b64 required" });
    }
    if (!ALLOWED_CHANNELS.has(body.channel)) {
      throw createError({ statusCode: 400, statusMessage: `invalid channel '${body.channel}'` });
    }
    if (!ALLOWED_ARCHES.has(body.arch)) {
      throw createError({ statusCode: 400, statusMessage: `invalid arch '${body.arch}'` });
    }

    const buf = Buffer.from(body.content_b64, "base64");
    if (buf.length === 0) {
      throw createError({ statusCode: 400, statusMessage: "empty artifact" });
    }

    const { sha256, signature } = deps.firmware.signBlob(buf);
    const artifactPath = await deps.firmware.storeBlob(buf, sha256);
    const id = randomUUID();
    const release = deps.repo.createFirmwareRelease({
      id,
      version: body.version,
      channel: body.channel,
      arch: body.arch,
      artifact_path: artifactPath,
      size_bytes: buf.length,
      sha256,
      signature,
      release_notes: body.release_notes ?? null,
      uploaded_by: null,
    });

    return { ok: true, release_id: release.id, sha256, signature };
  });

  // ---- Yank ---------------------------------------------------------------
  app.post("/admin/firmware/:id/yank", (event) => {
    const id = String(getRouterParam(event, "id"));
    deps.repo.yankFirmwareRelease(id);
    return new Response(null, { status: 302, headers: { location: "/admin/firmware" } });
  });

  // ---- Per-kiosk firmware settings ----------------------------------------
  // POST channel + target_version (used by KioskFirmwarePanel form)
  app.post("/admin/kiosks/:id/firmware", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const channelRaw = (body?.["channel"] ?? "stable").trim() as FirmwareChannel;
    const targetRaw = (body?.["target_version"] ?? "").trim();
    if (!ALLOWED_CHANNELS.has(channelRaw)) {
      throw createError({ statusCode: 400, statusMessage: "invalid channel" });
    }
    deps.repo.setKioskFirmwarePref(id, {
      channel: channelRaw,
      target_version: targetRaw ? targetRaw : null,
    });
    const k = deps.repo.getKioskById(id);
    if (!k) {
      return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    }
    const releases = deps.repo.listFirmwareReleases();
    return htmlFragment(KioskFirmwarePanel({ kiosk: k, releases }));
  });

  // Push update now: server pings the kiosk via WS coordinator so it goes
  // and pulls /api/kiosk/firmware/check immediately. The actual download
  // happens kiosk-side over the existing kiosk_key channel.
  app.post("/admin/kiosks/:id/firmware/push", (event) => {
    const id = Number(getRouterParam(event, "id"));
    const dispatched = getCoordinator().sendToKiosk(id, { type: "firmware_check" });
    return { ok: true, dispatched };
  });
}
