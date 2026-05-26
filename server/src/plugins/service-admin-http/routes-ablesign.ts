/**
 * AbleSign digital signage routes.
 */
import { type H3, getRouterParam, readBody, createError } from "h3";

import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import * as ablesign from "../../shared/ablesign.js";
import { AbleSignPage, AbleSignScreensPage } from "../../web-templates/admin-pages.js";

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
    await deps.repo.createAbleSignAccount({ name, api_key_encrypted: encrypted, workspace_id: workspaceId });
    return new Response(null, { status: 302, headers: { location: "/admin/ablesign" } });
  });

  app.get("/admin/ablesign/:id/screens", async (event) => {
    const id = getRouterParam(event, "id") ?? "";
    const account = await deps.repo.getAbleSignAccount(id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Account not found" });
    const screens = await deps.repo.listAbleSignScreens(id);
    const kiosks = await deps.repo.listKiosks();
    return htmlPage(AbleSignScreensPage({ account, screens, kiosks }));
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
        await deps.repo.upsertAbleSignScreen({
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
      return new Response(null, { status: 302, headers: { location: `/admin/ablesign/${accountId}/screens` } });
    }

    try {
      const apiKey = deps.secrets.decryptString(account.api_key_encrypted, "ablesign-key");
      const opts = { apiKey, workspaceId: account.workspace_id || undefined };
      const { screen } = await ablesign.headlessPairScreen(opts, title);

      await deps.repo.createAbleSignScreen({
        account_id: accountId,
        ablesign_screen_id: String(screen.id),
        title: screen.title,
        orientation: screen.orientation,
      });

      await deps.repo.updateAbleSignAccount(accountId, {
        screen_count: (account.screen_count ?? 0) + 1,
      });
    } catch {
      // redirect back — error handling TODO
    }

    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/${accountId}/screens` } });
  });

  app.post("/admin/ablesign/screens/:sid/assign", async (event) => {
    const sid = getRouterParam(event, "sid") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const kioskId = (body?.kiosk_id ?? "").trim() || null;
    await deps.repo.updateAbleSignScreen(sid, { kiosk_id: kioskId });

    const screen = await deps.repo.getAbleSignScreen(sid);
    const accountId = screen?.account_id ?? "";
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/${accountId}/screens` } });
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
    return new Response(null, { status: 302, headers: { location: `/admin/ablesign/${accountId}/screens` } });
  });
}
