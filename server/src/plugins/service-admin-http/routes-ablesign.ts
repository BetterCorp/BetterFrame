/**
 * AbleSign digital signage routes — full CMS management.
 */
import { type H3, getRouterParam, readBody, createError, getRequestHeader } from "h3";

import { htmlPage, htmlFragment } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import * as ablesign from "../../shared/ablesign.js";
import type { AbleSignPlaylist, AbleSignPlaylistItem, ApiOpts } from "../../shared/ablesign.js";
import { syncAbleSignAccount } from "../../shared/ablesign-sync.js";
import {
  AbleSignPage,
  AbleSignScreensPage,
  AbleSignScreenDetailPage,
  AbleSignContentPage,
  AbleSignPlaylistsPage,
  AbleSignPlaylistEditPage,
  AbleSignGroupsPage,
  AbleSignGroupDetailPage,
  renderScreensTable,
  renderPlaylistItems,
  renderContentGrid,
} from "../../web-templates/admin-pages.js";

function isHtmx(event: Parameters<typeof getRequestHeader>[0]): boolean {
  return getRequestHeader(event, "hx-request") === "true";
}

function accountOpts(deps: AdminDeps, account: any): ApiOpts {
  const apiKey = deps.secrets.decryptString(account.api_key_encrypted, "ablesign-key");
  return { apiKey, workspaceId: account.workspace_id || undefined };
}

export function registerAbleSignRoutes(app: H3, deps: AdminDeps): void {

  // ==== Accounts ===============================================================

  app.get("/admin/ablesign", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    return htmlPage(AbleSignPage({ accounts }));
  });

  app.post("/admin/ablesign/add", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.name ?? "").trim();
    const apiKey = (body?.api_key ?? "").trim();
    const workspaceId = (body?.workspace_id ?? "").trim() || undefined;

    if (!name || !apiKey) {
      const accounts = await deps.repo.listAbleSignAccounts();
      return htmlPage(AbleSignPage({ accounts, error: "Name and API key required." }));
    }

    const test = await ablesign.testApiKey(apiKey, workspaceId);
    if (!test.ok) {
      const accounts = await deps.repo.listAbleSignAccounts();
      return htmlPage(AbleSignPage({ accounts, error: `API key test failed: ${test.error}` }));
    }

    const encrypted = deps.secrets.encryptString(apiKey, "ablesign-key");
    const accountId = await deps.repo.createAbleSignAccount({ name, api_key_encrypted: encrypted, workspace_id: workspaceId });

    // Sync screens immediately after saving credentials.
    const fakeAccount = { id: accountId, name, api_key_encrypted: encrypted, workspace_id: workspaceId };
    try { await syncAbleSignAccount(fakeAccount, deps.repo, deps.secrets); } catch { /* non-fatal */ }

    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  app.get("/admin/ablesign/:id/screens", async () => {
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  app.post("/admin/ablesign/:id/sync", async (event) => {
    const id = getRouterParam(event, "id") ?? "";
    const account = await deps.repo.getAbleSignAccount(id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    try {
      await syncAbleSignAccount(account, deps.repo, deps.secrets);
    } catch (err) {
      await deps.repo.updateAbleSignAccount(id, {
        last_sync_at: new Date().toISOString(),
        last_sync_error: (err as Error).message,
      });
    }

    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  app.post("/admin/ablesign/:id/delete", async (event) => {
    const id = getRouterParam(event, "id") ?? "";
    await deps.repo.deleteAbleSignAccount(id);
    return new Response(null, { status: 302, headers: { location: "/admin/settings" } });
  });

  // ==== Screens ================================================================

  app.get("/admin/ablesign/screens", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const account = accounts[0] ?? null;
    const screens = account ? await deps.repo.listAbleSignScreens(account.id) : [];
    for (const s of screens) {
      (s as any).has_entity = !!(await deps.repo.getEntityByAbleSignScreen(s.id));
    }
    return htmlPage(AbleSignScreensPage({ screens, accountId: account?.id ?? null }));
  });

  // htmx polling fragment — returns just the screens table body
  app.get("/admin/ablesign/screens/fragment", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const account = accounts[0] ?? null;
    const screens = account ? await deps.repo.listAbleSignScreens(account.id) : [];
    for (const s of screens) {
      (s as any).has_entity = !!(await deps.repo.getEntityByAbleSignScreen(s.id));
    }
    return htmlFragment(renderScreensTable({ screens, accountId: account?.id ?? null }));
  });

  app.post("/admin/ablesign/:id/screens/add", async (event) => {
    const accountId = getRouterParam(event, "id") ?? "";
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const body = await readBody<Record<string, string>>(event);
    const title = (body?.title ?? "").trim();
    if (!title) {
      return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
    }

    try {
      const opts = accountOpts(deps, account);
      const result = await ablesign.headlessPairScreen(opts, title);

      const screenRowId = await deps.repo.createAbleSignScreen({
        account_id: accountId,
        ablesign_screen_id: result.screenId,
        ablesign_screen_token_encrypted: result.screenToken
          ? deps.secrets.encryptString(result.screenToken, "ablesign-token")
          : undefined,
        title: result.title,
        orientation: result.orientation,
      });

      await deps.repo.createEntity({
        name: `AbleSign: ${result.title}`,
        type: "ablesign",
        description: `AbleSign screen (ID: ${result.screenId})`,
        web_url: "https://player.ablesign.tv",
        ablesign_screen_id: screenRowId,
        managed: true,
      });

      // Re-sync after successful screen creation.
      try { await syncAbleSignAccount(account, deps.repo, deps.secrets); } catch { /* non-fatal */ }
    } catch (err) {
      const msg = (err as Error).message ?? "unknown error";
      event.context.obs?.log.warn("ablesign screen creation failed: {msg}", { msg });
      const screens = await deps.repo.listAbleSignScreens(accountId);
      for (const s of screens) (s as any).has_entity = !!(await deps.repo.getEntityByAbleSignScreen(s.id));
      return htmlPage(AbleSignScreensPage({ screens, accountId, error: `Screen creation failed: ${msg}` }));
    }

    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  app.post("/admin/ablesign/screens/:sid/assign", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const kioskId = (body?.kiosk_id ?? "").trim() || null;
    await deps.repo.updateAbleSignScreen(sid, { kiosk_id: kioskId });
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  // ---- Screen detail + config -------------------------------------------------

  app.get("/admin/ablesign/screens/:sid", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    let remoteScreen: any = null;
    let playlist: AbleSignPlaylist | null = null;
    if (account) {
      try {
        const opts = accountOpts(deps, account);
        remoteScreen = await ablesign.getScreen(opts, Number(screen.ablesign_screen_id));
      } catch { /* remote fetch failed */ }
      try {
        const opts = accountOpts(deps, account);
        playlist = await ablesign.getPlaylist(opts, Number(screen.ablesign_screen_id));
      } catch { /* playlist fetch failed */ }
    }
    const entity = await deps.repo.getEntityByAbleSignScreen(sid);
    return htmlPage(AbleSignScreenDetailPage({ screen, remoteScreen, entity, playlist }));
  });

  app.post("/admin/ablesign/screens/:sid", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const body = await readBody<Record<string, string>>(event);
    const title = (body?.title ?? "").trim();
    const orientation = body?.orientation ?? "landscape";
    const description = (body?.description ?? "").trim();

    try {
      const opts = accountOpts(deps, account);
      await ablesign.updateScreen(opts, Number(screen.ablesign_screen_id), {
        title: title || undefined,
        orientation,
        description: description || undefined,
      });
      if (title) {
        await deps.repo.updateAbleSignScreen(sid, { title, orientation });
      }
    } catch { /* update failed */ }

    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/screens/${sid}` } });
  });

  app.post("/admin/ablesign/screens/:sid/delete", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (screen) {
      try {
        const account = await deps.repo.getAbleSignAccount(screen.account_id);
        if (account) {
          const opts = accountOpts(deps, account);
          await ablesign.deleteScreen(opts, Number(screen.ablesign_screen_id));
        }
      } catch { /* best-effort remote delete */ }
      await deps.repo.deleteAbleSignScreen(sid);
    }
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  // ==== Playlists (per-screen) =================================================

  app.get("/admin/ablesign/screens/:sid/playlist", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    let playlist: AbleSignPlaylist = { items: [] };
    let content: Array<{ id: string; title: string; kind: "media" | "webapp"; fileType?: string }> = [];
    try { playlist = await ablesign.getPlaylist(opts, Number(screen.ablesign_screen_id)); } catch { /* empty */ }
    try {
      const [media, webApps] = await Promise.all([
        ablesign.listMediaFiles(opts),
        ablesign.listWebApps(opts),
      ]);
      for (const m of media.data) content.push({ id: m.id, title: m.title, kind: "media", fileType: m.fileType });
      for (const w of webApps.data) content.push({ id: w.id, title: w.title, kind: "webapp" });
    } catch { /* content fetch failed */ }

    return htmlPage(AbleSignPlaylistEditPage({ screen, playlist, content }));
  });

  app.post("/admin/ablesign/screens/:sid/playlist/settings", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const body = await readBody<Record<string, string>>(event);
    const opts = accountOpts(deps, account);
    const playlist = await ablesign.getPlaylist(opts, Number(screen.ablesign_screen_id));
    playlist.shufflePlay = body?.shufflePlay === "on";
    playlist.defaultTransition = body?.defaultTransition || undefined;
    playlist.defaultTransitionSpeedLabel = body?.defaultTransitionSpeedLabel || undefined;
    playlist.enableImageTransitions = body?.enableImageTransitions === "on";
    await ablesign.savePlaylist(opts, Number(screen.ablesign_screen_id), playlist);

    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/screens/${sid}/playlist` } });
  });

  app.post("/admin/ablesign/screens/:sid/playlist/add-items", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const body = await readBody<Record<string, any>>(event);
    const rawItems: string[] = Array.isArray(body?.items) ? body.items : (body?.items ? [body.items] : []);
    const duration = parseInt(body?.duration ?? "10", 10) || 10;
    const position = (body?.position === "start" ? "start" : "end") as "start" | "end";

    const items: AbleSignPlaylistItem[] = rawItems.map((raw) => {
      const [kind, id] = raw.split(":");
      return {
        mediafileId: kind === "media" ? id : undefined,
        webAppId: kind === "webapp" ? id : undefined,
        displayDuration: duration,
      };
    });

    if (items.length > 0) {
      const opts = accountOpts(deps, account);
      await ablesign.addPlaylistItems(opts, Number(screen.ablesign_screen_id), items, position);
    }

    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/screens/${sid}/playlist` } });
  });

  app.post("/admin/ablesign/screens/:sid/playlist/reorder", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const body = await readBody<Record<string, string>>(event);
    const index = parseInt(body?.index ?? "-1", 10);
    const direction = body?.direction === "up" ? "up" : "down";
    const opts = accountOpts(deps, account);
    const playlist = await ablesign.getPlaylist(opts, Number(screen.ablesign_screen_id));

    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (index >= 0 && swapWith >= 0 && swapWith < playlist.items.length && index < playlist.items.length) {
      const tmp = playlist.items[index]!;
      playlist.items[index] = playlist.items[swapWith]!;
      playlist.items[swapWith] = tmp;
      await ablesign.savePlaylist(opts, Number(screen.ablesign_screen_id), playlist);
    }

    if (isHtmx(event)) return htmlFragment(renderPlaylistItems(sid, playlist));
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/screens/${sid}/playlist` } });
  });

  app.post("/admin/ablesign/screens/:sid/playlist/remove-item", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const body = await readBody<Record<string, string>>(event);
    const index = parseInt(body?.index ?? "-1", 10);
    const opts = accountOpts(deps, account);
    const playlist = await ablesign.getPlaylist(opts, Number(screen.ablesign_screen_id));

    if (index >= 0 && index < playlist.items.length) {
      playlist.items.splice(index, 1);
      await ablesign.savePlaylist(opts, Number(screen.ablesign_screen_id), playlist);
    }

    if (isHtmx(event)) return htmlFragment(renderPlaylistItems(sid, playlist));
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/screens/${sid}/playlist` } });
  });

  app.post("/admin/ablesign/screens/:sid/playlist/update-item", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const body = await readBody<Record<string, string>>(event);
    const index = parseInt(body?.index ?? "-1", 10);
    const opts = accountOpts(deps, account);
    const playlist = await ablesign.getPlaylist(opts, Number(screen.ablesign_screen_id));

    if (index >= 0 && index < playlist.items.length) {
      const item = playlist.items[index]!;
      if (body?.displayDuration) item.displayDuration = parseInt(body.displayDuration, 10) || item.displayDuration;
      if (body?.transition !== undefined) item.transition = body.transition || undefined;
      if (body?.transitionSpeedLabel !== undefined) item.transitionSpeedLabel = body.transitionSpeedLabel || undefined;
      await ablesign.savePlaylist(opts, Number(screen.ablesign_screen_id), playlist);
    }

    if (isHtmx(event)) return htmlFragment(renderPlaylistItems(sid, playlist));
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/screens/${sid}/playlist` } });
  });

  // ==== Content Management =====================================================

  app.get("/admin/ablesign/content", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const content: Array<any> = [];
    const folders: Array<any> = [];
    for (const acct of accounts) {
      try {
        const opts = accountOpts(deps, acct);
        const [media, webApps, flds] = await Promise.all([
          ablesign.listMediaFiles(opts),
          ablesign.listWebApps(opts),
          ablesign.listFolders(opts),
        ]);
        for (const m of media.data) content.push({ ...m, account_id: acct.id, account_name: acct.name, kind: "media" });
        for (const w of webApps.data) content.push({ ...w, account_id: acct.id, account_name: acct.name, kind: "webapp" });
        for (const f of flds.data) folders.push({ ...f, account_id: acct.id, account_name: acct.name });
      } catch { /* skip failed accounts */ }
    }
    return htmlPage(AbleSignContentPage({ content, accounts, folders }));
  });

  // htmx fragment for content grid/list
  app.get("/admin/ablesign/content/fragment", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const content: Array<any> = [];
    for (const acct of accounts) {
      try {
        const opts = accountOpts(deps, acct);
        const [media, webApps] = await Promise.all([
          ablesign.listMediaFiles(opts),
          ablesign.listWebApps(opts),
        ]);
        for (const m of media.data) content.push({ ...m, account_id: acct.id, account_name: acct.name, kind: "media" });
        for (const w of webApps.data) content.push({ ...w, account_id: acct.id, account_name: acct.name, kind: "webapp" });
      } catch { /* skip */ }
    }
    return htmlFragment(renderContentGrid({ content }));
  });

  app.post("/admin/ablesign/content/websites/add", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const title = (body?.title ?? "").trim();
    const url = (body?.url ?? "").trim();
    const description = (body?.description ?? "").trim() || undefined;

    if (!accountId || !title || !url) {
      return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
    }

    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.createWebApp(opts, title, url, description);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  app.get("/admin/ablesign/content/websites/:wid/edit", async (event) => {
    const wid = getRouterParam(event, "wid") ?? "";
    const accountId = new URL(event.req.url ?? "", "http://localhost").searchParams.get("account_id") ?? "";
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    const webapp = await ablesign.getWebApp(opts, wid);
    const form = `<form method="POST" action="/admin/ablesign/content/websites/${wid}" style="display:flex; flex-direction:column; gap:0.5rem">
      <input type="hidden" name="account_id" value="${accountId}" />
      <label style="font-size:0.85rem">Title<br/><input type="text" name="title" value="${esc(webapp.title)}" style="width:100%" /></label>
      <label style="font-size:0.85rem">URL<br/><input type="url" name="url" value="${esc(webapp.url ?? "")}" style="width:100%" /></label>
      <label style="font-size:0.85rem">Description<br/><input type="text" name="description" value="${esc(webapp.description ?? "")}" style="width:100%" /></label>
      <label style="font-size:0.85rem">Zoom (%)<br/><input type="number" name="zoom" value="${String(webapp.zoom ?? 100)}" min="10" max="500" style="width:6rem" /></label>
      <div style="display:flex; gap:0.5rem; margin-top:0.5rem">
        <button type="submit" class="btn btn-sm">Save</button>
        <button type="button" class="btn btn-sm btn-ghost" onclick="this.closest('[data-edit-target]').innerHTML=''">Cancel</button>
      </div>
    </form>`;
    return htmlFragment(form);
  });

  app.post("/admin/ablesign/content/websites/:wid", async (event) => {
    const wid = getRouterParam(event, "wid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.updateWebApp(opts, wid, {
      title: body?.title || undefined,
      description: body?.description || undefined,
      url: body?.url || undefined,
      zoom: body?.zoom ? parseInt(body.zoom, 10) : undefined,
    });
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  app.post("/admin/ablesign/content/websites/:wid/delete", async (event) => {
    const wid = getRouterParam(event, "wid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.deleteWebApp(opts, wid);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  app.get("/admin/ablesign/content/media/:mid/edit", async (event) => {
    const mid = getRouterParam(event, "mid") ?? "";
    const accountId = new URL(event.req.url ?? "", "http://localhost").searchParams.get("account_id") ?? "";
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    const media = await ablesign.getMediaFile(opts, mid);
    const form = `<form method="POST" action="/admin/ablesign/content/media/${mid}" style="display:flex; flex-direction:column; gap:0.5rem">
      <input type="hidden" name="account_id" value="${accountId}" />
      <label style="font-size:0.85rem">Title<br/><input type="text" name="title" value="${esc(media.title)}" style="width:100%" /></label>
      <label style="font-size:0.85rem">Description<br/><input type="text" name="description" value="${esc(media.description ?? "")}" style="width:100%" /></label>
      <div style="display:flex; gap:0.5rem; margin-top:0.5rem">
        <button type="submit" class="btn btn-sm">Save</button>
        <button type="button" class="btn btn-sm btn-ghost" onclick="this.closest('[data-edit-target]').innerHTML=''">Cancel</button>
      </div>
    </form>`;
    return htmlFragment(form);
  });

  app.post("/admin/ablesign/content/media/:mid", async (event) => {
    const mid = getRouterParam(event, "mid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.updateMediaFile(opts, mid, {
      title: body?.title || undefined,
      description: body?.description || undefined,
    });
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  app.post("/admin/ablesign/content/media/:mid/delete", async (event) => {
    const mid = getRouterParam(event, "mid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.deleteMediaFile(opts, mid);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  app.post("/admin/ablesign/content/media/upload", async (event) => {
    const body = await readBody<Record<string, any>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const filename = (body?.filename ?? "").trim();
    const mimeType = (body?.mimeType ?? "application/octet-stream").trim();
    const fileData = body?.fileData as string | undefined;
    const folderId = (body?.folder_id ?? "").trim() || undefined;

    if (!filename || !fileData) {
      return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
    }

    const buf = Buffer.from(fileData, "base64");
    const opts = accountOpts(deps, account);
    const upload = await ablesign.initMediaUpload(opts, filename, mimeType, buf.length, folderId);

    // PUT file bytes to presigned URL
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    try {
      const putResp = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: buf,
        signal: ctrl.signal,
      });
      if (!putResp.ok) throw new Error(`Upload PUT failed: HTTP ${putResp.status}`);
    } finally {
      clearTimeout(t);
    }

    await ablesign.finishMediaUpload(opts, upload.uploadId);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  // ---- Folders ----------------------------------------------------------------

  app.post("/admin/ablesign/content/folders/add", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const title = (body?.title ?? "").trim();
    const parentFolderId = (body?.parent_folder_id ?? "").trim() || undefined;

    if (!accountId || !title) {
      return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
    }

    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.createFolder(opts, title, parentFolderId);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  app.post("/admin/ablesign/content/folders/:fid", async (event) => {
    const fid = getRouterParam(event, "fid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const title = (body?.title ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.updateFolder(opts, fid, title);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  app.post("/admin/ablesign/content/folders/:fid/delete", async (event) => {
    const fid = getRouterParam(event, "fid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.deleteFolder(opts, fid);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/content" } });
  });

  // ==== Screen Groups ==========================================================

  app.get("/admin/ablesign/groups", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const groups: Array<any> = [];
    for (const acct of accounts) {
      try {
        const opts = accountOpts(deps, acct);
        const result = await ablesign.listScreenGroups(opts);
        for (const g of result.data) groups.push({ ...g, account_id: acct.id, account_name: acct.name });
      } catch { /* skip */ }
    }
    return htmlPage(AbleSignGroupsPage({ groups, accounts }));
  });

  app.post("/admin/ablesign/groups/add", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const title = (body?.title ?? "").trim();
    const description = (body?.description ?? "").trim() || undefined;

    if (!accountId || !title) {
      return new Response(null, { status: 302, headers: { location: "/admin/ablesign/groups" } });
    }

    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.createScreenGroup(opts, title, description);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/groups" } });
  });

  app.get("/admin/ablesign/groups/:gid", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const accountId = new URL(event.req.url ?? "", "http://localhost").searchParams.get("account_id") ?? "";
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    const group = await ablesign.getScreenGroup(opts, gid);
    const members = await ablesign.getScreenGroupMembers(opts, gid);
    const allScreens = await ablesign.listScreens(opts);
    return htmlPage(AbleSignGroupDetailPage({
      group,
      members: members.data,
      allScreens: allScreens.data,
      accountId,
    }));
  });

  app.post("/admin/ablesign/groups/:gid", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.updateScreenGroup(opts, gid, {
      title: body?.title || undefined,
      description: body?.description || undefined,
    });
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/groups/${gid}?account_id=${accountId}` } });
  });

  app.post("/admin/ablesign/groups/:gid/delete", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    await ablesign.deleteScreenGroup(opts, gid);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/groups" } });
  });

  app.post("/admin/ablesign/groups/:gid/members", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const body = await readBody<Record<string, any>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const rawIds: string[] = Array.isArray(body?.screen_ids) ? body.screen_ids : (body?.screen_ids ? [body.screen_ids] : []);
    const screenIds = rawIds.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));

    const opts = accountOpts(deps, account);
    await ablesign.setScreenGroupMembers(opts, gid, screenIds);
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/groups/${gid}?account_id=${accountId}` } });
  });

  // ---- Group playlists (reuse same pattern as screen playlists) ---------------

  app.get("/admin/ablesign/groups/:gid/playlist", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const accountId = new URL(event.req.url ?? "", "http://localhost").searchParams.get("account_id") ?? "";
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    const group = await ablesign.getScreenGroup(opts, gid);
    let playlist: AbleSignPlaylist = { items: [] };
    let content: Array<{ id: string; title: string; kind: "media" | "webapp"; fileType?: string }> = [];
    try { playlist = await ablesign.getScreenGroupPlaylist(opts, gid); } catch { /* empty */ }
    try {
      const [media, webApps] = await Promise.all([ablesign.listMediaFiles(opts), ablesign.listWebApps(opts)]);
      for (const m of media.data) content.push({ id: m.id, title: m.title, kind: "media", fileType: m.fileType });
      for (const w of webApps.data) content.push({ id: w.id, title: w.title, kind: "webapp" });
    } catch { /* empty */ }

    return htmlPage(AbleSignPlaylistEditPage({
      screen: { id: `group-${gid}`, title: group.title, ablesign_screen_id: String(gid) },
      playlist,
      content,
      isGroup: true,
      accountId,
    }));
  });

  app.post("/admin/ablesign/groups/:gid/playlist/settings", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const opts = accountOpts(deps, account);
    const playlist = await ablesign.getScreenGroupPlaylist(opts, gid);
    playlist.shufflePlay = body?.shufflePlay === "on";
    playlist.defaultTransition = body?.defaultTransition || undefined;
    playlist.defaultTransitionSpeedLabel = body?.defaultTransitionSpeedLabel || undefined;
    await ablesign.saveScreenGroupPlaylist(opts, gid, playlist);
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/groups/${gid}/playlist?account_id=${accountId}` } });
  });

  app.post("/admin/ablesign/groups/:gid/playlist/add-items", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const body = await readBody<Record<string, any>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const rawItems: string[] = Array.isArray(body?.items) ? body.items : (body?.items ? [body.items] : []);
    const duration = parseInt(body?.duration ?? "10", 10) || 10;
    const position = (body?.position === "start" ? "start" : "end") as "start" | "end";
    const items: AbleSignPlaylistItem[] = rawItems.map((raw) => {
      const [kind, id] = raw.split(":");
      return { mediafileId: kind === "media" ? id : undefined, webAppId: kind === "webapp" ? id : undefined, displayDuration: duration };
    });

    if (items.length > 0) {
      const opts = accountOpts(deps, account);
      await ablesign.addScreenGroupPlaylistItems(opts, gid, items, position);
    }
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/groups/${gid}/playlist?account_id=${accountId}` } });
  });

  app.post("/admin/ablesign/groups/:gid/playlist/reorder", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const index = parseInt(body?.index ?? "-1", 10);
    const direction = body?.direction === "up" ? "up" : "down";
    const opts = accountOpts(deps, account);
    const playlist = await ablesign.getScreenGroupPlaylist(opts, gid);
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (index >= 0 && swapWith >= 0 && swapWith < playlist.items.length && index < playlist.items.length) {
      const tmp = playlist.items[index]!;
      playlist.items[index] = playlist.items[swapWith]!;
      playlist.items[swapWith] = tmp;
      await ablesign.saveScreenGroupPlaylist(opts, gid, playlist);
    }
    if (isHtmx(event)) return htmlFragment(renderPlaylistItems(`group-${gid}`, playlist));
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/groups/${gid}/playlist?account_id=${accountId}` } });
  });

  app.post("/admin/ablesign/groups/:gid/playlist/remove-item", async (event) => {
    const gid = parseInt(getRouterParam(event, "gid") ?? "0", 10);
    const body = await readBody<Record<string, string>>(event);
    const accountId = (body?.account_id ?? "").trim();
    const account = await deps.repo.getAbleSignAccount(accountId);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    const index = parseInt(body?.index ?? "-1", 10);
    const opts = accountOpts(deps, account);
    const playlist = await ablesign.getScreenGroupPlaylist(opts, gid);
    if (index >= 0 && index < playlist.items.length) {
      playlist.items.splice(index, 1);
      await ablesign.saveScreenGroupPlaylist(opts, gid, playlist);
    }
    if (isHtmx(event)) return htmlFragment(renderPlaylistItems(`group-${gid}`, playlist));
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/groups/${gid}/playlist?account_id=${accountId}` } });
  });

  // ==== Global Playlists Overview ==============================================

  app.get("/admin/ablesign/playlists", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const screens = await deps.repo.listAbleSignScreens();
    const playlists: any[] = [];
    for (const s of screens) {
      const acct = accounts.find((a: any) => a.id === s.account_id);
      if (!acct) continue;
      try {
        const opts = accountOpts(deps, acct);
        const pl = await ablesign.getPlaylist(opts, Number(s.ablesign_screen_id));
        playlists.push({ screen_title: s.title, screen_sid: s.id, account_name: acct.name, ...pl });
      } catch { /* skip */ }
    }
    return htmlPage(AbleSignPlaylistsPage({ playlists }));
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
