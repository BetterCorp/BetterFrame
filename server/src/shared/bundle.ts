/**
 * Bundle generation — display-chain routing.
 *
 * kiosk → enabled displays → layouts/cells plus operate-label cameras.
 */
import { createHash } from "node:crypto";
import type { Observable } from "@bsb/base";
import type { Repository } from "./db/repository.js";
import type { SecretsApi } from "./secrets.js";
import type { Camera, CameraStream, CellContentType, Entity } from "./types.js";
import { parseRtspUri, stripRtspCredentials } from "./rtsp.js";
import { createOnvifCallbackToken } from "./onvif-callback-token.js";

function resolvePlaybackCredentials(
  cam: Camera,
  streams: Array<Pick<CameraStream, "rtsp_uri">>,
): { username: string | null; password: string | null } {
  if (cam.onvif_username || cam.onvif_password) {
    return {
      username: cam.onvif_username ?? null,
      password: cam.onvif_password ?? null,
    };
  }

  const candidates = [
    cam.rtsp_url,
    ...streams.map((s) => s.rtsp_uri),
  ];
  for (const raw of candidates) {
    const parsed = parseRtspUri(raw);
    if (parsed.username || parsed.password) {
      return {
        username: parsed.username,
        password: parsed.password,
      };
    }
  }
  return { username: null, password: null };
}

export interface BundleCamera {
  id: string;
  device_id: string | null;
  device_name: string | null;
  name: string;
  camera_number: string | null;
  labels: string[];
  capabilities: string[];
  enabled: boolean;
  last_seen_at: string | null;
  simple_vms_managed: boolean;
  recording_config: Record<string, unknown>;
  type: string;
  onvif_host: string | null;
  onvif_port: number | null;
  onvif_username: string | null;
  onvif_password_encrypted: string | null;
  playback_username: string | null;
  playback_password_encrypted: string | null;
  event_source: string;
  event_sink: string;
  event_callback_token: string;
  stream_policy: string;
  streams: Array<{
    id: string;
    role: string;
    name: string;
    profile_token: string | null;
    /** Final playable RTSP URL with properly encoded credentials. */
    rtsp_uri: string;
    width: number | null;
    height: number | null;
    encoding: string | null;
    framerate: number | null;
  }>;
}

export interface BundleCell {
  view_id: string;
  entity_id: string | null;
  row: number;
  col: number;
  row_span: number;
  col_span: number;
  content_type: string;
  camera_id: string | null;
  stream_selector: string | null;
  web_url: string | null;
  html_content: string | null;
  cooling_timeout_seconds: number | null;
  fit: "cover" | "contain" | "fill";
  /** Smart URL action steps — automated login/navigation sequence. */
  smart_url?: {
    steps: Array<{
      type: string;
      url?: string;
      selector?: string;
      value?: string;
      value_encrypted?: string;
      delay_ms?: number;
      timeout_ms?: number;
      script?: string;
    }>;
    login_detect_url?: string;
    session_check_interval_ms?: number;
  };
  /** Key→value pairs injected into WebView localStorage before page load. */
  local_storage?: Record<string, string>;
  input_options?: Record<string, unknown>;
}

export interface BundleLayout {
  id: string;
  name: string;
  /** Computed from cells: max(col + col_span). 1 if no cells. */
  grid_cols: number;
  /** Computed from cells: max(row + row_span). 1 if no cells. */
  grid_rows: number;
  priority: string;
  cooling_timeout_seconds: number | null;
  idle_timeout_seconds: number | null;
  preload_camera_ids: string[];
  resets_idle_timer: boolean;
  /** True if the kiosk's display has this layout as its default_layout_id. */
  is_default: boolean;
  cells: BundleCell[];
  input_options?: Record<string, unknown>;
}

export interface BundleDisplay {
  id: string;
  name: string;
  width_px: number;
  height_px: number;
  idle_timeout_seconds: number;
  sleep_timeout_seconds: number;
  default_layout_id: string | null;
}

export interface BundleDisplayWithLayouts extends BundleDisplay {
  layouts: BundleLayout[];
}

export interface BundleGpioBinding {
  id: string;
  chip: string;
  pin: number;
  direction: "in" | "out";
  pull: "up" | "down" | "none" | null;
  edge: "rising" | "falling" | "both" | null;
  topic: string;
}

export interface KioskBundle {
  kiosk_id: string;
  kiosk_name: string;
  tenant_slug: string;
  /**
   * @deprecated Use `displays` (array). Kept for backward compat with older
   * kiosk builds that consume a single display. Mirrors `displays[0]`.
   */
  display: BundleDisplay;
  /**
   * @deprecated Use `displays[N].layouts`. Mirrors `displays[0].layouts` for
   * older kiosk builds.
   */
  layouts: BundleLayout[];
  /** All physical displays driven by this kiosk. New (multi-display) shape. */
  displays: BundleDisplayWithLayouts[];
  cameras: BundleCamera[];
  gpio_bindings: BundleGpioBinding[];
  operator_console: {
    enabled: boolean;
    host: string | null;
    port: number;
    tools: Array<{ label: string; url: string }>;
    simple_vms: {
      enabled: boolean;
      storage_path: string | null;
      settings: Record<string, unknown>;
    };
  };
  version: string;
}

export class BundleGenerationError extends Error {
  readonly code: string;

  constructor(readonly phase: string, cause: Error) {
    super(`bundle generation failed during ${phase}`, { cause });
    this.code = typeof (cause as Error & { code?: unknown }).code === "string"
      ? String((cause as Error & { code: string }).code)
      : cause.name;
  }
}

export async function generateBundle(
  repo: Repository,
  secrets: SecretsApi,
  kioskId: string,
  clusterKey: string | undefined,
  obs?: Observable,
): Promise<KioskBundle | null> {
  const span = obs?.startSpan("generateBundle", { "kiosk.id": kioskId });
  let phase = "load-kiosk";
  try {
  const kiosk = await repo.getKioskById(kioskId);
  if (!kiosk) {
    span?.log.info("bundle: kiosk {id} not found", { id: String(kioskId) });
    span?.end();
    return null;
  }

  // Per-kiosk encryption key (preferred) — decrypt from server storage.
  let kioskEncryptKey: string | undefined;
  if (kiosk.encrypt_key_encrypted) {
    try {
      kioskEncryptKey = secrets.decryptString(kiosk.encrypt_key_encrypted, "kiosk-encrypt");
    } catch {
      // Decrypt failed — fall back to cluster key.
    }
  }

  phase = "load-displays";
  // Find all displays for this kiosk (displays now point to kiosks via kiosk_id)
  const kioskDisplays = await repo.listDisplaysForKiosk(kioskId);
  // Fall back to legacy kiosk.display_id if no displays point to this kiosk yet
  const allDisplays = kioskDisplays.length > 0
    ? kioskDisplays
    : (kiosk.display_id ? [await repo.getDisplayById(kiosk.display_id)].filter((d): d is NonNullable<typeof d> => d != null) : []);

  // Admin can disable a display — kiosk must never open a window on it.
  const displays = allDisplays.filter((d) => d.is_enabled);
  if (displays.length === 0) {
    span?.log.info("bundle: kiosk {id} has no enabled displays", { id: String(kioskId) });
    span?.end();
    return null;
  }

  phase = "load-scope";
  // Collect camera IDs across ALL displays' layouts (de-duped).
  const allLayoutIds = new Set<string>();
  for (const d of displays) {
    for (const l of await repo.layoutsForDisplayId(d.id)) allLayoutIds.add(l.id);
  }
  const layoutCameras = await repo.camerasForLayoutIds([...allLayoutIds]);
  const scope = await repo.bundleScope(kioskId);
  const operateCameras = await repo.camerasForLabelIds(scope.operateLabelIds);
  const operateCameraIds = new Set(operateCameras.map((camera) => camera.id));
  const cameraById = new Map(layoutCameras.map((camera) => [camera.id, camera]));
  for (const camera of operateCameras) cameraById.set(camera.id, camera);
  const cameras = [...cameraById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const deviceNames = new Map((await repo.listCameraDevices()).map((device) => [device.id, device.name]));
  const stableEncryptedValues = new Map<string, string>();

  function encryptForBundle(plaintext: string, key: string, stableContext: string): string {
    const ciphertext = secrets.encryptForCluster(plaintext, key);
    stableEncryptedValues.set(ciphertext, stableSecretFingerprint(stableContext, plaintext));
    return ciphertext;
  }

  async function resolveEntityContent(ent: Entity): Promise<{
    contentType: CellContentType;
    cameraId: string | null;
    webUrl: string | null;
    htmlContent: string | null;
    localStorage?: Record<string, string>;
  }> {
    let localStorage: Record<string, string> | undefined;
    if (ent.type === "ablesign" && ent.ablesign_screen_id) {
      const screen = await repo.getAbleSignScreen(ent.ablesign_screen_id);
      if (screen) {
        localStorage = { screenId: screen.ablesign_screen_id };
        if (screen.ablesign_screen_token_encrypted) {
          try {
            localStorage["screenToken"] = secrets.decryptString(
              screen.ablesign_screen_token_encrypted,
              "ablesign-token",
            );
          } catch { /* player will show pairing */ }
        }
      }
    }
    return {
      contentType: ent.type === "dashboard" || ent.type === "ablesign" ? "web" : ent.type,
      cameraId: ent.type === "camera" ? ent.camera_id : null,
      webUrl:
        ent.type === "web" || ent.type === "ablesign" ? ent.web_url :
        ent.type === "dashboard" && ent.dashboard_id ? `/dash/${ent.dashboard_id}` :
        null,
      htmlContent: ent.type === "html" ? ent.html_content : null,
      localStorage,
    };
  }

  const operatorContent = kiosk.operator_console_enabled
    ? (await repo.listEntities()).filter((entity) => entity.type !== "camera")
    : [];

  async function buildLayouts(displayId: string, defaultLayoutId: string | null): Promise<BundleLayout[]> {
    const layouts = await repo.layoutsForDisplayId(displayId);
    const result: BundleLayout[] = [];
    const virtualLayouts = new Map<string, BundleLayout>();
    for (const l of layouts) {
      const cells = await repo.layoutCells(l.id);
      let gridCols = 1;
      let gridRows = 1;
      for (const c of cells) {
        const right = c.col + c.col_span;
        const bottom = c.row + c.row_span;
        if (right > gridCols) gridCols = right;
        if (bottom > gridRows) gridRows = bottom;
      }
      const bundleCells: BundleCell[] = [];
      for (const c of cells) {
        // If the cell has an entity, prefer its current content so admin
        // edits to the entity propagate without forcing a cell-touch. The
        // bundle still ships the legacy camera_id/web_url/html_content shape
        // so the existing Rust kiosk consumes it unchanged.
        let contentType = c.content_type;
        let cellLocalStorage: Record<string, string> | undefined;
        let cellInputOptions: Record<string, unknown> | undefined = c.input_options_json;
        let cameraId = c.camera_id;
        let webUrl = c.web_url;
        let htmlContent = c.html_content;
        if (c.entity_id != null) {
          const ent = await repo.getEntityById(c.entity_id);
          if (ent) {
            const resolved = await resolveEntityContent(ent);
            contentType = resolved.contentType;
            cameraId = resolved.cameraId;
            webUrl = resolved.webUrl;
            htmlContent = resolved.htmlContent;
            cellLocalStorage = resolved.localStorage;
            cellInputOptions = Object.keys(ent.input_options_json ?? {}).length > 0
              ? ent.input_options_json
              : cellInputOptions;
          }
        }
        const bundleCell: BundleCell = {
          view_id: c.id,
          entity_id: c.entity_id,
          row: c.row,
          col: c.col,
          row_span: c.row_span,
          col_span: c.col_span,
          content_type: contentType,
          camera_id: cameraId,
          stream_selector: c.stream_selector,
          web_url: webUrl,
          html_content: htmlContent,
          cooling_timeout_seconds: c.cooling_timeout_seconds,
          fit: c.fit,
          // Smart URL: encrypted credentials use per-kiosk key so each
          // kiosk's bundle has uniquely encrypted values.
          smart_url: c.options?.["smart_url"] ? (() => {
            const raw = c.options["smart_url"] as any;
            const steps = Array.isArray(raw.steps) ? raw.steps.map((s: any) => {
              const step = { ...s };
              // Encrypt plaintext values with per-kiosk key for transport.
              const ek = kioskEncryptKey ?? clusterKey;
              if (step.value && step.type === "fill" && ek) {
                step.value_encrypted = encryptForBundle(step.value, ek, `smart-url:${c.id}:${String(step.selector ?? "")}`);
                delete step.value;
              }
              return step;
            }) : [];
            return {
              steps,
              login_detect_url: raw.login_detect_url,
              session_check_interval_ms: raw.session_check_interval_ms,
            };
          })() : undefined,
          local_storage: cellLocalStorage,
          input_options: cellInputOptions,
        };
        bundleCells.push(bundleCell);
        if (c.entity_id != null && !virtualLayouts.has(c.entity_id)) {
          const ent = await repo.getEntityById(c.entity_id);
          if (ent) {
            // Cell-level click/hold actions (e.g. switch-to-fullscreen) must not
            // fire again inside the fullscreen layout itself.
            const { events: _cellEvents, ...fullscreenInputOptions } =
              (bundleCell.input_options ?? {}) as Record<string, unknown>;
            virtualLayouts.set(c.entity_id, {
              id: ent.id,
              name: `Full Screen: ${ent.name}`,
              grid_cols: 1,
              grid_rows: 1,
              priority: "normal",
              cooling_timeout_seconds: l.cooling_timeout_seconds,
              idle_timeout_seconds: l.idle_timeout_seconds,
              preload_camera_ids: [],
              resets_idle_timer: true,
              is_default: false,
              cells: [{
                ...bundleCell,
                view_id: `virtual:${ent.id}`,
                row: 0,
                col: 0,
                row_span: 1,
                col_span: 1,
                input_options: fullscreenInputOptions,
              }],
              input_options: ent.input_options_json,
            });
          }
        }
      }
      result.push({
        id: l.id,
        name: l.name,
        grid_cols: gridCols,
        grid_rows: gridRows,
        priority: l.priority,
        cooling_timeout_seconds: l.cooling_timeout_seconds,
        idle_timeout_seconds: l.idle_timeout_seconds,
        preload_camera_ids: l.preload_camera_ids,
        resets_idle_timer: l.resets_idle_timer,
        is_default: defaultLayoutId === l.id,
        cells: bundleCells,
        input_options: l.input_options_json,
      });
    }
    for (const ent of operatorContent) {
      if (virtualLayouts.has(ent.id)) continue;
      const resolved = await resolveEntityContent(ent);
      virtualLayouts.set(ent.id, {
        id: ent.id,
        name: `Full Screen: ${ent.name}`,
        grid_cols: 1,
        grid_rows: 1,
        priority: "normal",
        cooling_timeout_seconds: null,
        idle_timeout_seconds: null,
        preload_camera_ids: [],
        resets_idle_timer: true,
        is_default: false,
        cells: [{
          view_id: `operator:${ent.id}`,
          entity_id: ent.id,
          row: 0,
          col: 0,
          row_span: 1,
          col_span: 1,
          content_type: resolved.contentType,
          camera_id: resolved.cameraId,
          stream_selector: null,
          web_url: resolved.webUrl,
          html_content: resolved.htmlContent,
          cooling_timeout_seconds: null,
          fit: "contain",
          local_storage: resolved.localStorage,
          input_options: ent.input_options_json,
        }],
        input_options: ent.input_options_json,
      });
    }
    const realLayoutIds = new Set(result.map((layout) => layout.id));
    for (const [entityId, layout] of virtualLayouts) {
      if (!realLayoutIds.has(entityId)) result.push(layout);
    }
    return result;
  }

  phase = "build-displays";
  const bundleDisplays: BundleDisplayWithLayouts[] = [];
  for (const display of displays) {
    bundleDisplays.push({
      id: display.id,
      name: stripDisplayKioskPrefix(display.name, kiosk.name),
      width_px: display.width_px,
      height_px: display.height_px,
      idle_timeout_seconds: display.idle_timeout_seconds,
      sleep_timeout_seconds: display.sleep_timeout_seconds,
      default_layout_id: display.default_layout_id,
      layouts: await buildLayouts(display.id, display.default_layout_id),
    });
  }

  phase = "event-ownership";
  // Release stale ONVIF event ownership: if the owning kiosk hasn't been
  // seen in 24h, revert to "auto" so this (or another) kiosk can claim it.
  await repo.releaseStaleEventOwnership(24);

  // ONVIF event ownership: for "auto" cameras, first kiosk to fetch bundle
  // claims ownership in the bundle output so the kiosk knows to subscribe.
  // We do NOT persist this to the cameras table — the DB stays "auto".
  const callbackTokens = new Map<string, string>();
  for (const cam of cameras) {
    const callback = createOnvifCallbackToken(
      secrets,
      cam.id,
      cam.event_callback_nonce ?? undefined,
    );
    if (cam.event_callback_nonce !== callback.nonce || cam.event_callback_token_hash !== callback.hash) {
      await repo.setCameraEventCallbackToken(cam.id, callback.nonce, callback.hash);
    }
    callbackTokens.set(cam.id, callback.token);
    if (cam.type === "onvif" && cam.event_source === "auto") {
      cam.event_source = `kiosk:${kioskId}`;
    }
  }

  phase = "build-cameras";
  const bundleCameras: BundleCamera[] = [];
  for (const cam of cameras) {
    phase = `build-camera-streams:${cam.id}`;
    const streams = await repo.listCameraStreams(cam.id);
    const effectiveStreams = streams.length > 0 ? streams : (
      cam.type === "rtsp" && cam.rtsp_url
        ? [{
          id: "",
          role: "main" as const,
          name: "Main",
          profile_token: null as string | null,
          rtsp_uri: stripRtspCredentials(cam.rtsp_url) ?? cam.rtsp_url,
          width: null,
          height: null,
          encoding: null,
          framerate: null,
        }]
        : []
    );
    phase = `build-camera-credentials:${cam.id}`;
    const playbackCreds = resolvePlaybackCredentials(cam, effectiveStreams);
    // Encrypt camera password with per-kiosk key if available (stronger
    // isolation — compromised SD only exposes this kiosk's cameras). Falls
    // back to shared cluster_key for kiosks that paired before per-kiosk
    // keys were introduced.
    let onvifPwEncrypted: string | null = null;
    const encryptKey = kioskEncryptKey ?? clusterKey;
    if (cam.onvif_password && encryptKey) {
      onvifPwEncrypted = encryptForBundle(cam.onvif_password, encryptKey, `onvif:${cam.id}`);
    }
    let playbackPwEncrypted: string | null = null;
    if (playbackCreds.password && encryptKey) {
      playbackPwEncrypted = encryptForBundle(playbackCreds.password, encryptKey, `playback:${cam.id}`);
    }
    phase = `build-camera-labels:${cam.id}`;
    const labels = await repo.cameraLabelNames(cam.id);
    phase = `build-camera:${cam.id}`;
    bundleCameras.push({
      id: cam.id,
      device_id: cam.device_id,
      device_name: cam.device_id ? deviceNames.get(cam.device_id) ?? null : null,
      name: cam.name,
      camera_number: cam.camera_number,
      labels,
      capabilities: cam.capabilities,
      enabled: cam.enabled,
      last_seen_at: cam.last_seen_at,
      simple_vms_managed: operateCameraIds.has(cam.id),
      recording_config: cam.recording_config_json,
      type: cam.type,
      onvif_host: cam.onvif_host,
      onvif_port: cam.onvif_port,
      onvif_username: cam.onvif_username,
      onvif_password_encrypted: onvifPwEncrypted,
      playback_username: playbackCreds.username,
      playback_password_encrypted: playbackPwEncrypted,
      event_source: cam.event_source,
      event_sink: cam.event_sink,
      event_callback_token: callbackTokens.get(cam.id)!,
      stream_policy: cam.stream_policy,
      streams: effectiveStreams.map((s) => ({
        id: s.id,
        role: s.role,
        name: s.name,
        profile_token: s.profile_token ?? null,
        // Bundle ships credential-free RTSP endpoints; kiosk injects
        // playback credentials locally when starting the pipeline.
        rtsp_uri: stripRtspCredentials(s.rtsp_uri) ?? s.rtsp_uri,
        width: s.width,
        height: s.height,
        encoding: s.encoding,
        framerate: s.framerate,
      })),
    });
  }

  phase = "load-gpio";
  const gpioBindings: BundleGpioBinding[] = (await repo.listGpioBindings(kioskId)).map((g) => ({
    id: g.id,
    chip: g.chip,
    pin: g.pin,
    direction: g.direction,
    pull: g.pull,
    edge: g.edge,
    topic: g.topic,
  }));

  // Mirror first display into the legacy top-level `display` + `layouts` so
  // older kiosk builds keep working unchanged. New builds should read
  // `displays`.
  const primary = bundleDisplays[0]!;
  const bundle: KioskBundle = {
    kiosk_id: kioskId,
    kiosk_name: kiosk.name,
    tenant_slug: "default",
    display: {
      id: primary.id,
      name: primary.name,
      width_px: primary.width_px,
      height_px: primary.height_px,
      idle_timeout_seconds: primary.idle_timeout_seconds,
      sleep_timeout_seconds: primary.sleep_timeout_seconds,
      default_layout_id: primary.default_layout_id,
    },
    layouts: primary.layouts,
    displays: bundleDisplays,
    cameras: bundleCameras,
    gpio_bindings: gpioBindings,
    operator_console: {
      enabled: kiosk.operator_console_enabled,
      host: kiosk.operator_console_host,
      port: kiosk.operator_console_port,
      tools: parseOperatorTools(kiosk.operator_tools_json),
      simple_vms: {
        enabled: kiosk.simple_vms_enabled,
        storage_path: kiosk.simple_vms_storage_path,
        settings: parseJsonObject(kiosk.simple_vms_settings_json),
      },
    },
    version: "",
  };

  phase = "serialize";
  bundle.version = createHash("sha256")
    .update(JSON.stringify(stableBundleForVersion(bundle, stableEncryptedValues)))
    .digest("hex");

  span?.log.info("bundle generated for kiosk {id} version {ver}", {
    id: String(kioskId),
    ver: bundle.version.slice(0, 12),
  });
  span?.end({
    status: "ok",
    "bundle.displays": bundleDisplays.length,
    "bundle.cameras": bundleCameras.length,
  });
  return bundle;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    span?.log.error("bundle generation failed for kiosk {id} during {phase}: {message}", {
      id: String(kioskId),
      phase,
      message: error.message,
    });
    span?.error(error, { "bundle.phase": phase });
    span?.end({ status: "error", "bundle.phase": phase });
    throw new BundleGenerationError(phase, error);
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value != null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseOperatorTools(raw: string | null): Array<{ label: string; url: string }> {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const label = String((item as Record<string, unknown>)["label"] ?? "").trim();
      const url = String((item as Record<string, unknown>)["url"] ?? "").trim();
      return label && /^https?:\/\//i.test(url) ? [{ label, url }] : [];
    });
  } catch {
    return [];
  }
}

function stripDisplayKioskPrefix(displayName: string, kioskName: string): string {
  const prefix = `${kioskName}: `;
  return displayName.startsWith(prefix) ? displayName.slice(prefix.length) : displayName;
}

function stableSecretFingerprint(context: string, plaintext: string): string {
  return `secret:${createHash("sha256").update(context).update("\0").update(plaintext).digest("hex")}`;
}

function stableBundleForVersion(value: unknown, encryptedValues: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableBundleForVersion(item, encryptedValues));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "version") {
      out[key] = "";
    } else if (typeof raw === "string" && key.endsWith("_encrypted")) {
      out[key] = encryptedValues.get(raw) ?? raw;
    } else {
      out[key] = stableBundleForVersion(raw, encryptedValues);
    }
  }
  return out;
}
