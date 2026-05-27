/**
 * AbleSign API client — full CMS management.
 *
 * Base URL: https://api.ablesign.tv/api/v1
 * Auth: Bearer ak_... (API key from AbleSign CMS)
 * Docs: https://apidocs.ablesign.tv/
 *
 * The player at player.ablesign.tv uses an internal registration API
 * (POST /api/screens/registration) that doesn't need auth. We use the
 * public API (v1) with the admin's API key for all management ops, and
 * the internal player API for headless screen registration.
 */

const API_BASE = "https://api.ablesign.tv/api/v1";
const PLAYER_API = "https://api.ablesign.tv/api";

// ---- Interfaces ---------------------------------------------------------------

export interface AbleSignScreen {
  id: number;
  title: string;
  description?: string;
  orientation: string;
  heartbeatTime?: string;
  screenGroupId?: number;
}

export interface AbleSignPlaylistItem {
  id?: string;
  mediafileId?: string;
  webAppId?: string;
  displayDuration?: number;
  sequenceNumber?: number;
  transition?: string;
  transitionSpeedLabel?: string;
  scheduleEnabled?: boolean;
  periodicScheduleEnabled?: boolean;
}

export interface AbleSignPlaylist {
  defaultTransition?: string;
  defaultTransitionSpeedLabel?: string;
  shufflePlay?: boolean;
  enableImageTransitions?: boolean;
  items: AbleSignPlaylistItem[];
}

export interface AbleSignRegistration {
  id: number;
  code: number;
  screenId: number;
}

export interface AbleSignWebApp {
  id: string;
  title: string;
  description?: string;
  url?: string;
  html?: string;
  zoom?: number;
  startDate?: string;
  expirationDate?: string;
  tags?: string[];
}

export interface AbleSignMediaFile {
  id: string;
  title: string;
  description?: string;
  fileType: string;
  thumbnailURL?: string;
  accessUrl?: string;
  folderId?: string;
  startDate?: string;
  expirationDate?: string;
  tags?: string[];
}

export interface AbleSignFolder {
  id: string;
  title: string;
  parentFolderId?: string;
}

export interface AbleSignScreenGroup {
  id: number;
  title: string;
  description?: string;
}

export interface AbleSignUploadInit {
  uploadId: string;
  uploadUrl: string;
}

export interface ApiOpts {
  apiKey: string;
  workspaceId?: string;
  timeoutMs?: number;
}

function headers(opts: ApiOpts): Record<string, string> {
  const h: Record<string, string> = {
    "Authorization": `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (opts.workspaceId) {
    h["Workspace-Id"] = opts.workspaceId;
  }
  return h;
}

async function apiFetch<T>(
  method: string,
  path: string,
  opts: ApiOpts,
  body?: unknown,
): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: headers(opts),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`AbleSign API ${method} ${path}: HTTP ${resp.status} — ${text.slice(0, 300)}`);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function listScreens(opts: ApiOpts): Promise<{ data: AbleSignScreen[]; totalItems: number }> {
  return apiFetch("GET", "/screens?limit=200", opts);
}

export async function getScreen(opts: ApiOpts, screenId: number): Promise<AbleSignScreen> {
  return apiFetch("GET", `/screens/${screenId}`, opts);
}

export async function registerScreen(
  opts: ApiOpts,
  registrationCode: string,
  title: string,
  orientation: string = "landscape",
): Promise<AbleSignScreen> {
  const resp = await apiFetch<{ status?: string; data?: AbleSignScreen } & AbleSignScreen>("POST", "/screens", opts, {
    registrationCode,
    title,
    orientation,
  });
  return resp.data ?? resp;
}

export async function updateScreen(
  opts: ApiOpts,
  screenId: number,
  patch: { title?: string; description?: string; orientation?: string },
): Promise<void> {
  await apiFetch("PUT", `/screens/${screenId}`, opts, patch);
}

export async function deleteScreen(opts: ApiOpts, screenId: number): Promise<void> {
  await apiFetch("DELETE", `/screens/${screenId}`, opts);
}

export async function getPlaylist(opts: ApiOpts, screenId: number): Promise<AbleSignPlaylist> {
  return apiFetch("GET", `/screens/${screenId}/playlist`, opts);
}

export async function savePlaylist(
  opts: ApiOpts,
  screenId: number,
  playlist: AbleSignPlaylist,
): Promise<void> {
  await apiFetch("PUT", `/screens/${screenId}/playlist`, opts, playlist);
}

export async function addPlaylistItems(
  opts: ApiOpts,
  screenId: number,
  items: AbleSignPlaylistItem[],
  position: "start" | "end" = "end",
): Promise<void> {
  await apiFetch("POST", `/screens/${screenId}/playlist_items`, opts, { items, position });
}

// ---- Web Apps -----------------------------------------------------------------

export async function listWebApps(opts: ApiOpts): Promise<{ data: AbleSignWebApp[] }> {
  return apiFetch("GET", "/web_apps?limit=200", opts);
}

export async function getWebApp(opts: ApiOpts, id: string): Promise<AbleSignWebApp> {
  return apiFetch("GET", `/web_apps/${id}`, opts);
}

export async function createWebApp(
  opts: ApiOpts,
  title: string,
  url: string,
  description?: string,
): Promise<AbleSignWebApp> {
  return apiFetch("POST", "/web_apps", opts, { title, url, description });
}

export async function updateWebApp(
  opts: ApiOpts,
  id: string,
  patch: { title?: string; description?: string; url?: string; zoom?: number; tags?: string[]; startDate?: string; expirationDate?: string },
): Promise<void> {
  await apiFetch("PUT", `/web_apps/${id}`, opts, patch);
}

export async function deleteWebApp(opts: ApiOpts, id: string): Promise<void> {
  await apiFetch("DELETE", `/web_apps/${id}`, opts);
}

// ---- Media Files --------------------------------------------------------------

export async function listMediaFiles(opts: ApiOpts): Promise<{ data: AbleSignMediaFile[] }> {
  return apiFetch("GET", "/media_files?limit=200", opts);
}

export async function getMediaFile(opts: ApiOpts, id: string): Promise<AbleSignMediaFile> {
  return apiFetch("GET", `/media_files/${id}`, opts);
}

export async function updateMediaFile(
  opts: ApiOpts,
  id: string,
  patch: { title?: string; description?: string; tags?: string[]; startDate?: string; expirationDate?: string },
): Promise<void> {
  await apiFetch("PUT", `/media_files/${id}`, opts, patch);
}

export async function deleteMediaFile(opts: ApiOpts, id: string): Promise<void> {
  await apiFetch("DELETE", `/media_files/${id}`, opts);
}

export async function initMediaUpload(
  opts: ApiOpts,
  filename: string,
  mimeType: string,
  size: number,
  folderId?: string,
): Promise<AbleSignUploadInit> {
  return apiFetch("POST", "/media_files/init_upload", opts, { filename, mimeType, size, folderId });
}

export async function finishMediaUpload(opts: ApiOpts, uploadId: string): Promise<AbleSignMediaFile> {
  return apiFetch("POST", "/media_files/finish_upload", opts, { uploadId });
}

// ---- Folders ------------------------------------------------------------------

export async function listFolders(opts: ApiOpts, folderId?: string): Promise<{ data: AbleSignFolder[] }> {
  const qs = folderId ? `?limit=200&folderId=${folderId}` : "?limit=200";
  return apiFetch("GET", `/folders${qs}`, opts);
}

export async function createFolder(opts: ApiOpts, title: string, parentFolderId?: string): Promise<AbleSignFolder> {
  return apiFetch("POST", "/folders", opts, { title, parentFolderId });
}

export async function updateFolder(opts: ApiOpts, id: string, title: string): Promise<void> {
  await apiFetch("PUT", `/folders/${id}`, opts, { title });
}

export async function deleteFolder(opts: ApiOpts, id: string): Promise<void> {
  await apiFetch("DELETE", `/folders/${id}`, opts);
}

// ---- Screen Groups ------------------------------------------------------------

export async function listScreenGroups(opts: ApiOpts): Promise<{ data: AbleSignScreenGroup[] }> {
  return apiFetch("GET", "/screen_groups?limit=200", opts);
}

export async function createScreenGroup(opts: ApiOpts, title: string, description?: string): Promise<AbleSignScreenGroup> {
  return apiFetch("POST", "/screen_groups", opts, { title, description });
}

export async function getScreenGroup(opts: ApiOpts, id: number): Promise<AbleSignScreenGroup> {
  return apiFetch("GET", `/screen_groups/${id}`, opts);
}

export async function updateScreenGroup(
  opts: ApiOpts,
  id: number,
  patch: { title?: string; description?: string },
): Promise<void> {
  await apiFetch("PUT", `/screen_groups/${id}`, opts, patch);
}

export async function deleteScreenGroup(opts: ApiOpts, id: number): Promise<void> {
  await apiFetch("DELETE", `/screen_groups/${id}`, opts);
}

export async function getScreenGroupPlaylist(opts: ApiOpts, id: number): Promise<AbleSignPlaylist> {
  return apiFetch("GET", `/screen_groups/${id}/playlist`, opts);
}

export async function saveScreenGroupPlaylist(opts: ApiOpts, id: number, playlist: AbleSignPlaylist): Promise<void> {
  await apiFetch("PUT", `/screen_groups/${id}/playlist`, opts, playlist);
}

export async function addScreenGroupPlaylistItems(
  opts: ApiOpts,
  id: number,
  items: AbleSignPlaylistItem[],
  position: "start" | "end" = "end",
): Promise<void> {
  await apiFetch("POST", `/screen_groups/${id}/playlist_items`, opts, { items, position });
}

export async function getScreenGroupMembers(opts: ApiOpts, id: number): Promise<{ data: AbleSignScreen[] }> {
  return apiFetch("GET", `/screen_groups/${id}/screens`, opts);
}

export async function setScreenGroupMembers(opts: ApiOpts, id: number, screenIds: number[]): Promise<void> {
  await apiFetch("PUT", `/screen_groups/${id}/screens`, opts, { screens: screenIds });
}

// ---- Playlist Item (per-item PATCH) -------------------------------------------

export async function updatePlaylistItem(
  opts: ApiOpts,
  screenId: number,
  itemId: string,
  patch: { displayDuration?: number; transition?: string; scheduleEnabled?: boolean; periodicScheduleEnabled?: boolean },
): Promise<void> {
  await apiFetch("PATCH", `/screens/${screenId}/playlist_items/${itemId}`, opts, patch);
}

/**
 * Initiate headless screen registration via the player's internal API.
 * No auth required — mimics what player.ablesign.tv does on load.
 */
export async function initiatePlayerRegistration(): Promise<AbleSignRegistration> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(`${PLAYER_API}/screens/registration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-version": "46" },
      body: JSON.stringify({ platformType: "Web", softwareVersionCode: 46 }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`registration init: HTTP ${resp.status}`);
    return (await resp.json()) as AbleSignRegistration;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Poll for registration completion. Returns screenId when paired, -1 while pending.
 */
export async function pollRegistration(code: number): Promise<{ screenId: number; screenToken?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(`${PLAYER_API}/screens/registration/${code}`, {
      method: "GET",
      headers: { "Accept": "application/json", "x-app-version": "46" },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`registration poll: HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    return {
      screenId: (data.screenId as number) ?? -1,
      screenToken: (data.token as string | undefined) ?? (data.screenToken as string | undefined),
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Full headless pairing flow:
 * 1. Initiate registration → get code
 * 2. Register screen via admin API with that code
 * 3. Return screen details + any token for the player
 */
export async function headlessPairScreen(
  opts: ApiOpts,
  title: string,
  orientation: string = "landscape",
): Promise<{ screenId: string; screenToken?: string; title: string; orientation: string; registrationCode: number }> {
  // 1. Initiate player-side registration → get code
  const reg = await initiatePlayerRegistration();

  // 2. Pair via admin API — consumes the code
  const screen = await registerScreen(opts, String(reg.code), title, orientation);

  // 3. Poll registration endpoint with retries to get screenId + token.
  // The admin API pairing is async — token may not be ready immediately.
  let screenId = screen?.id ? String(screen.id) : undefined;
  let screenToken: string | undefined;

  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const poll = await pollRegistration(reg.code);
      if (poll.screenId > 0) {
        screenId = String(poll.screenId);
        screenToken = poll.screenToken;
        break;
      }
    } catch { /* retry */ }
  }

  return {
    screenId: screenId ?? String(reg.code),
    screenToken,
    title: screen?.title || title,
    orientation: screen?.orientation || orientation,
    registrationCode: reg.code,
  };
}

export async function testApiKey(apiKey: string, workspaceId?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await listScreens({ apiKey, workspaceId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
