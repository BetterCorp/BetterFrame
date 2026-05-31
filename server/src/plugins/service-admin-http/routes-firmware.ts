/**
 * Admin firmware routes — release upload, list, yank, per-kiosk push.
 *
 * Upload path supports:
 *   - browser multipart form ("upload from your machine")
 *   - CI auto-import via Authorization: Bearer <token>. The token may be a
 *     DB-backed admin API key or the single-purpose BF_FIRMWARE_IMPORT_API_KEY.
 *     POST /api/admin/firmware/import with JSON {version, channel, arch,
 *     release_notes, content_b64} so GitHub Actions can publish releases
 *     without a session.
 */
import { type H3, getRouterParam, readBody, createError } from "h3";
import { randomUUID } from "node:crypto";

import { htmlPage, htmlFragment } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import {
  FirmwarePage,
  FirmwareRolloutsPage,
  KioskFirmwarePanel,
} from "../../web-templates/admin-pages.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import { audit } from "../../shared/audit.js";
import type { FirmwareChannel } from "../../shared/types.js";
import { currentTenantSchema, isDefaultTenant, withDefaultTenant } from "../../shared/default-tenant.js";
import {
  FIRMWARE_TARGET_PC_X86_64,
  FIRMWARE_TARGET_RPI5,
  normalizeFirmwareTarget,
} from "../../shared/firmware-targets.js";

const ALLOWED_CHANNELS: ReadonlySet<FirmwareChannel> = new Set(["stable", "beta", "dev"]);
const ALLOWED_TARGETS = new Set([
  FIRMWARE_TARGET_RPI5,
  FIRMWARE_TARGET_PC_X86_64,
]);
const ALLOWED_IOBOX_ARCHES = new Set(["esp32s3"]);

export function registerFirmwareRoutes(app: H3, deps: AdminDeps): void {
  // ---- List page -----------------------------------------------------------
  app.get("/admin/firmware", async (event) => {
    if (!isDefaultTenant(event)) return new Response(null, { status: 404 });
    const user = event.context.user!;
    const releases = await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.listFirmwareReleases());
    return htmlPage(FirmwarePage({
      user: user.username,
      releases,
      publicKeyPem: deps.firmware.publicKeyPem(),
    }));
  });

  // ---- Human upload (multipart) -------------------------------------------
  app.post("/admin/firmware/upload", async (event) => {
    if (!isDefaultTenant(event)) return new Response(null, { status: 404 });
    const user = event.context.user!;
    const req = event.req;
    const form = await req.formData();
    const file = form.get("artifact");
    if (!(file instanceof File)) {
      throw createError({ statusCode: 400, statusMessage: "artifact file required" });
    }
    const version = String(form.get("version") ?? "").trim();
    const channelRaw = String(form.get("channel") ?? "stable").trim();
    const target = normalizeFirmwareTarget(String(form.get("target") || form.get("arch") || "").trim());
    const releaseNotes = String(form.get("release_notes") ?? "").trim() || null;

    if (!ALLOWED_CHANNELS.has(channelRaw as FirmwareChannel)) {
      throw createError({ statusCode: 400, statusMessage: `invalid channel '${channelRaw}'` });
    }
    if (!ALLOWED_TARGETS.has(target)) {
      throw createError({ statusCode: 400, statusMessage: `invalid target '${target}'` });
    }
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      throw createError({ statusCode: 400, statusMessage: `invalid version '${version}' (expected semver)` });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const { sha256, signature } = deps.firmware.signBlob(buf);
    const artifactPath = await deps.firmware.storeBlob(buf, sha256);

    const release = await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.createFirmwareRelease({
      id: randomUUID(),
      version,
      channel: channelRaw as FirmwareChannel,
      arch: target,
      artifact_path: artifactPath,
      size_bytes: buf.length,
      sha256,
      signature,
      release_notes: releaseNotes,
      uploaded_by: user.id,
    }));
    await audit(deps.repo, event as any, "firmware.upload", {
      resource_type: "firmware_release",
      resource_id: release.id,
      metadata: { version, channel: channelRaw, target, sha256, size: buf.length },
    });

    return new Response(null, { status: 302, headers: { location: "/admin/firmware" } });
  });

  // ---- CI auto-import (JSON, API-key-auth) --------------------------------
  // Body: {version, channel, target, release_notes?, content_b64}; legacy arch is accepted.
  // Server signs server-side (no client-side trust required for signing key)
  app.post("/api/admin/firmware/import", async (event) => {
    // Middleware already verified API key on /api/admin/* — admin scope
    // checked there. No further auth needed here.
    const body = await readBody<{
      version: string;
      channel: FirmwareChannel;
      target?: string;
      arch?: string;
      release_notes?: string;
      content_b64: string;
    }>(event);

    const target = normalizeFirmwareTarget(body?.target || body?.arch);
    if (!body?.version || !body.channel || !target || !body.content_b64) {
      throw createError({ statusCode: 400, statusMessage: "version, channel, target, content_b64 required" });
    }
    if (!ALLOWED_CHANNELS.has(body.channel)) {
      throw createError({ statusCode: 400, statusMessage: `invalid channel '${body.channel}'` });
    }
    if (!ALLOWED_TARGETS.has(target)) {
      throw createError({ statusCode: 400, statusMessage: `invalid target '${target}'` });
    }

    const buf = Buffer.from(body.content_b64, "base64");
    if (buf.length === 0) {
      throw createError({ statusCode: 400, statusMessage: "empty artifact" });
    }

    const { sha256, signature } = deps.firmware.signBlob(buf);
    const artifactPath = await deps.firmware.storeBlob(buf, sha256);
    const id = randomUUID();
    const release = await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.createFirmwareRelease({
      id,
      version: body.version,
      channel: body.channel,
      arch: target,
      artifact_path: artifactPath,
      size_bytes: buf.length,
      sha256,
      signature,
      release_notes: body.release_notes ?? null,
      uploaded_by: null,
    }));

    return { ok: true, release_id: release.id, sha256, signature };
  });

  app.post("/api/admin/iobox/firmware/import", async (event) => {
    const body = await readBody<{
      version: string;
      channel: FirmwareChannel;
      firmware_arch?: string;
      model_id?: string | null;
      release_notes?: string;
      content_b64: string;
    }>(event);

    const firmwareArch = body?.firmware_arch || "esp32s3";
    const modelId = body?.model_id?.trim() || null;
    if (!body?.version || !body.channel || !body.content_b64) {
      throw createError({ statusCode: 400, statusMessage: "version, channel, content_b64 required" });
    }
    if (!ALLOWED_CHANNELS.has(body.channel)) {
      throw createError({ statusCode: 400, statusMessage: `invalid channel '${body.channel}'` });
    }
    if (!ALLOWED_IOBOX_ARCHES.has(firmwareArch)) {
      throw createError({ statusCode: 400, statusMessage: `invalid ioBOX arch '${firmwareArch}'` });
    }
    if (modelId && !(await deps.repo.getIoBoxModel(modelId))) {
      throw createError({ statusCode: 400, statusMessage: `unknown ioBOX model '${modelId}'` });
    }

    const buf = Buffer.from(body.content_b64, "base64");
    if (buf.length === 0) throw createError({ statusCode: 400, statusMessage: "empty artifact" });

    const { sha256, signature } = deps.firmware.signBlob(buf);
    const artifactPath = await deps.firmware.storeBlob(buf, sha256);
    const release = await deps.repo.createIoBoxFirmwareRelease({
      id: randomUUID(),
      version: body.version,
      channel: body.channel,
      firmware_arch: firmwareArch,
      model_id: modelId,
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
  app.post("/admin/firmware/:id/yank", async (event) => {
    if (!isDefaultTenant(event)) return new Response(null, { status: 404 });
    const id = String(getRouterParam(event, "id"));
    await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.yankFirmwareRelease(id));
    await audit(deps.repo, event as any, "firmware.yank", {
      resource_type: "firmware_release",
      resource_id: id,
    });
    return new Response(null, { status: 302, headers: { location: "/admin/firmware" } });
  });

  // ---- Per-kiosk firmware settings ----------------------------------------
  // POST channel + target_version (used by KioskFirmwarePanel form)
  app.post("/admin/kiosks/:id/firmware", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const channelRaw = (body?.["channel"] ?? "stable").trim() as FirmwareChannel;
    const targetRaw = (body?.["target_version"] ?? "").trim();
    if (!ALLOWED_CHANNELS.has(channelRaw)) {
      throw createError({ statusCode: 400, statusMessage: "invalid channel" });
    }
    const before = await deps.repo.getKioskById(id);
    if (!before) {
      return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    }
    if (targetRaw) {
      const target = normalizeFirmwareTarget(before.firmware_target);
      if (!target) {
        throw createError({ statusCode: 400, statusMessage: "kiosk firmware target unknown; wait for kiosk check-in" });
      }
      const release = await withDefaultTenant(deps.repo, currentTenantSchema(event), () =>
        deps.repo.getFirmwareReleaseByVersionArch(targetRaw, target)
      );
      if (!release || release.yanked_at) {
        throw createError({ statusCode: 400, statusMessage: "target version is not available for this kiosk target" });
      }
    }
    await deps.repo.setKioskFirmwarePref(id, {
      channel: channelRaw,
      target_version: targetRaw ? targetRaw : null,
    });
    const k = await deps.repo.getKioskById(id);
    if (!k) {
      return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    }
    const nextTarget = targetRaw ? targetRaw : null;
    if (before && (before.firmware_channel !== channelRaw || before.firmware_target_version !== nextTarget)) {
      const coord = getCoordinator();
      coord.sendToKiosk(id, {
        type: "update_cancel",
        reason: "firmware preference changed",
      });
      coord.sendToKiosk(id, { type: "firmware_check", force: false });
    }
    const releases = await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.listFirmwareReleases());
    return htmlFragment(KioskFirmwarePanel({ kiosk: k, releases }));
  });

  // Push update now: server pings the kiosk via WS coordinator so it goes
  // and pulls /api/kiosk/firmware/check immediately. The actual download
  // happens kiosk-side over the existing kiosk_key channel.
  app.post("/admin/kiosks/:id/firmware/push", (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const dispatched = getCoordinator().sendToKiosk(id, { type: "firmware_check", force: true });
    return { ok: true, dispatched };
  });

  // ---- Rollouts -----------------------------------------------------------

  app.get("/admin/firmware/rollouts", async (event) => {
    if (!isDefaultTenant(event)) return new Response(null, { status: 404 });
    const user = event.context.user!;
    const [rollouts, releases] = await withDefaultTenant(deps.repo, currentTenantSchema(event), async () => Promise.all([
      deps.repo.listFirmwareRollouts(),
      deps.repo.listFirmwareReleases(),
    ]));
    const kiosks = await deps.repo.listKiosks();
    return htmlPage(FirmwareRolloutsPage({
      user: user.username,
      rollouts,
      releases,
      kiosks,
    }));
  });

  app.post("/admin/firmware/rollouts/new", async (event) => {
    if (!isDefaultTenant(event)) return new Response(null, { status: 404 });
    const body = await readBody<Record<string, string | string[]>>(event);
    const releaseId = String(body?.["release_id"] ?? "");
    if (!releaseId) throw createError({ statusCode: 400, statusMessage: "release_id required" });
    const release = await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.getFirmwareRelease(releaseId));
    if (!release) throw createError({ statusCode: 404, statusMessage: "release not found" });
    const releaseTarget = normalizeFirmwareTarget(release.arch);
    const percentage = clamp(Number(body?.["percentage"] ?? 100), 1, 100);
    const targetsRaw = body?.["target_kiosk_ids"];
    const targets: string[] = Array.isArray(targetsRaw)
      ? targetsRaw.map((s) => String(s)).filter((s) => s !== "")
      : typeof targetsRaw === "string" && targetsRaw
        ? targetsRaw.split(",").map((s) => s.trim()).filter((s) => s !== "")
        : [];
    if (targets.length > 0) {
      for (const kioskId of targets) {
        const kiosk = await deps.repo.getKioskById(kioskId);
        if (!kiosk) throw createError({ statusCode: 400, statusMessage: `unknown kiosk '${kioskId}'` });
        if (normalizeFirmwareTarget(kiosk.firmware_target) !== releaseTarget) {
          throw createError({ statusCode: 400, statusMessage: `kiosk '${kiosk.name}' does not match release target` });
        }
      }
    }
    const user = event.context.user!;
    const rollout = await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.createFirmwareRollout({
      id: randomUUID(),
      release_id: releaseId,
      target_kiosk_ids: targets,
      percentage,
      created_by: user.id ?? null,
    }));
    await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.updateFirmwareRolloutState(rollout.id, "active"));
    await audit(deps.repo, event as any, "firmware.rollout.create", {
      resource_type: "firmware_rollout",
      resource_id: rollout.id,
      metadata: { release_id: releaseId, percentage, target_count: targets.length },
    });
    // Bump every targeted kiosk to check now (best-effort over WS).
    // This is an auto-rollout check; only the explicit Push button uses force.
    const coord = getCoordinator();
    if (targets.length === 0) {
      const allKiosks = await deps.repo.listKiosks();
      for (const k of allKiosks) {
        if (normalizeFirmwareTarget(k.firmware_target) === releaseTarget) {
          coord.sendToKiosk(k.id, { type: "firmware_check", force: false });
        }
      }
    } else {
      for (const id of targets) coord.sendToKiosk(id, { type: "firmware_check", force: false });
    }
    return new Response(null, { status: 302, headers: { location: "/admin/firmware/rollouts" } });
  });

  app.post("/admin/firmware/rollouts/:id/state", async (event) => {
    if (!isDefaultTenant(event)) return new Response(null, { status: 404 });
    const id = String(getRouterParam(event, "id"));
    const body = await readBody<{ state: string }>(event);
    const state = body?.state;
    if (state !== "paused" && state !== "active" && state !== "complete") {
      throw createError({ statusCode: 400, statusMessage: "invalid state" });
    }
    await withDefaultTenant(deps.repo, currentTenantSchema(event), () => deps.repo.updateFirmwareRolloutState(id, state));
    return new Response(null, { status: 302, headers: { location: "/admin/firmware/rollouts" } });
  });
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
