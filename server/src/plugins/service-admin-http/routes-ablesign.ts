/**
 * AbleSign digital signage routes.
 */
import { type H3, getRouterParam, readBody, createError } from "h3";

import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import * as ablesign from "../../shared/ablesign.js";
import { AbleSignPage, AbleSignScreensPage, AbleSignScreenDetailPage, AbleSignContentPage, AbleSignPlaylistsPage } from "../../web-templates/admin-pages.js";

export function registerAbleSignRoutes(app: H3, deps: AdminDeps): void {

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

    // Auto-sync screens on account creation.
    try {
      const opts = { apiKey, workspaceId };
      const result = await ablesign.listScreens(opts);
      for (const s of result.data) {
        await deps.repo.upsertAbleSignScreen({
          account_id: accountId,
          ablesign_screen_id: String(s.id),
          title: s.title,
          online: !!s.heartbeatTime,
          last_heartbeat_at: s.heartbeatTime || undefined,
          orientation: s.orientation,
        });
      }
      await deps.repo.updateAbleSignAccount(accountId, {
        screen_count: result.data.length,
        last_sync_at: new Date().toISOString(),
      });
    } catch { /* sync failure is non-fatal */ }

    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  // Redirect old per-account route to global screens page.
  app.get("/admin/ablesign/:id/screens", async () => {
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  app.post("/admin/ablesign/:id/sync", async (event) => {
    const id = getRouterParam(event, "id") ?? "";
    const account = await deps.repo.getAbleSignAccount(id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });

    try {
      const apiKey = deps.secrets.decryptString(account.api_key_encrypted, "ablesign-key");
      const opts = { apiKey, workspaceId: account.workspace_id || undefined };
      const result = await ablesign.listScreens(opts);

      for (const s of result.data) {
        const screenRowId = await deps.repo.upsertAbleSignScreen({
          account_id: id,
          ablesign_screen_id: String(s.id),
          title: s.title,
          online: !!s.heartbeatTime,
          last_heartbeat_at: s.heartbeatTime || undefined,
          orientation: s.orientation,
        });
      }

      await deps.repo.updateAbleSignAccount(id, {
        screen_count: result.data.length,
        last_sync_at: new Date().toISOString(),
        last_sync_error: null,
      });
    } catch (err) {
      await deps.repo.updateAbleSignAccount(id, {
        last_sync_at: new Date().toISOString(),
        last_sync_error: (err as Error).message,
      });
    }

    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/${id}/screens` } });
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
      const apiKey = deps.secrets.decryptString(account.api_key_encrypted, "ablesign-key");
      const opts = { apiKey, workspaceId: account.workspace_id || undefined };
      const { screen, registrationCode } = await ablesign.headlessPairScreen(opts, title);

      // Poll once for token (may not be available immediately).
      let screenToken: string | undefined;
      try {
        const poll = await ablesign.pollRegistration(registrationCode);
        screenToken = poll.screenToken;
      } catch { /* token may not be ready yet — kiosk can work without it initially */ }

      const screenRowId = await deps.repo.createAbleSignScreen({
        account_id: accountId,
        ablesign_screen_id: String(screen.id),
        ablesign_screen_token_encrypted: screenToken
          ? deps.secrets.encryptString(screenToken, "ablesign-token")
          : undefined,
        title: screen.title,
        orientation: screen.orientation,
      });

      await deps.repo.createEntity({
        name: `AbleSign: ${screen.title}`,
        type: "ablesign",
        description: `AbleSign screen (ID: ${String(screen.id)})`,
        web_url: "https://player.ablesign.tv",
        ablesign_screen_id: screenRowId,
        managed: true,
      });

      await deps.repo.updateAbleSignAccount(accountId, {
        screen_count: (account.screen_count ?? 0) + 1,
      });
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

    const screen = await deps.repo.getAbleSignScreen(sid);
    const accountId = screen?.account_id ?? "";
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  // ---- Screen detail + config -------------------------------------------------

  app.get("/admin/ablesign/screens/:sid", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (!screen) throw createError({ statusCode: 404, statusMessage: "Screen not found" });
    const account = await deps.repo.getAbleSignAccount(screen.account_id);
    let remoteScreen: any = null;
    if (account) {
      try {
        const apiKey = deps.secrets.decryptString(account.api_key_encrypted, "ablesign-key");
        remoteScreen = await ablesign.getScreen(
          { apiKey, workspaceId: account.workspace_id || undefined },
          Number(screen.ablesign_screen_id),
        );
      } catch { /* remote fetch failed */ }
    }
    const entity = await deps.repo.getEntityByAbleSignScreen(sid);
    return htmlPage(AbleSignScreenDetailPage({ screen, remoteScreen, entity }));
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
      const apiKey = deps.secrets.decryptString(account.api_key_encrypted, "ablesign-key");
      await ablesign.updateScreen(
        { apiKey, workspaceId: account.workspace_id || undefined },
        Number(screen.ablesign_screen_id),
        { title: title || undefined, orientation, description: description || undefined },
      );
      if (title) {
        await deps.repo.updateAbleSignScreen(sid, { title, orientation });
      }
    } catch { /* update failed */ }

    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/screens/${sid}` } });
  });

  app.post("/admin/ablesign/:id/delete", async (event) => {
    const id = getRouterParam(event, "id") ?? "";
    await deps.repo.deleteAbleSignAccount(id);
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign" } });
  });

  app.post("/admin/ablesign/screens/:sid/delete", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const screen = await deps.repo.getAbleSignScreen(sid);
    if (screen) {
      try {
        const account = await deps.repo.getAbleSignAccount(screen.account_id);
        if (account) {
          const apiKey = deps.secrets.decryptString(account.api_key_encrypted, "ablesign-key");
          await ablesign.deleteScreen(
            { apiKey, workspaceId: account.workspace_id || undefined },
            Number(screen.ablesign_screen_id),
          );
        }
      } catch { /* best-effort remote delete */ }
      await deps.repo.deleteAbleSignScreen(sid);
    }
    const accountId = screen?.account_id ?? "";
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign/screens" } });
  });

  // ---- Global views (all accounts aggregated) --------------------------------

  app.get("/admin/ablesign/screens", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const account = accounts[0] ?? null;
    const screens = account ? await deps.repo.listAbleSignScreens(account.id) : [];
    for (const s of screens) {
      (s as any).has_entity = !!(await deps.repo.getEntityByAbleSignScreen(s.id));
    }
    return htmlPage(AbleSignScreensPage({ screens, accountId: account?.id ?? null }));
  });

  app.get("/admin/ablesign/content", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const content: any[] = [];
    for (const acct of accounts) {
      try {
        const apiKey = deps.secrets.decryptString(acct.api_key_encrypted, "ablesign-key");
        const opts = { apiKey, workspaceId: acct.workspace_id || undefined };
        const media = await ablesign.listMediaFiles(opts);
        const webApps = await ablesign.listWebApps(opts);
        for (const m of media.data) content.push({ ...m, account_name: acct.name, kind: "media" });
        for (const w of webApps.data) content.push({ ...w, account_name: acct.name, kind: "webapp" });
      } catch { /* skip failed accounts */ }
    }
    return htmlPage(AbleSignContentPage({ content, accounts }));
  });

  app.get("/admin/ablesign/playlists", async () => {
    const accounts = await deps.repo.listAbleSignAccounts();
    const screens = await deps.repo.listAbleSignScreens();
    const playlists: any[] = [];
    for (const s of screens) {
      const acct = accounts.find((a: any) => a.id === s.account_id);
      if (!acct) continue;
      try {
        const apiKey = deps.secrets.decryptString(acct.api_key_encrypted, "ablesign-key");
        const opts = { apiKey, workspaceId: acct.workspace_id || undefined };
        const pl = await ablesign.getPlaylist(opts, Number(s.ablesign_screen_id));
        playlists.push({ screen_title: s.title, account_name: acct.name, ...pl });
      } catch { /* skip */ }
    }
    return htmlPage(AbleSignPlaylistsPage({ playlists }));
  });
}
