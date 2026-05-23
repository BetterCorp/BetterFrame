/**
 * Admin cloud camera account routes.
 *
 * /admin/cloud-accounts         — list + add form
 * /admin/cloud-accounts/:id/sync — trigger camera sync
 * /admin/cloud-accounts/:id/delete — remove account
 * /admin/cloud-accounts/:id/import — import discovered cameras as BF cameras
 */
import { type H3, getRouterParam, readBody, createError } from "h3";
import { randomUUID } from "node:crypto";

import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { CLOUD_VENDORS, VENDOR_LABELS, getProvider, listProviders, type CloudVendor } from "../../shared/cloud-cameras/index.js";
import { CloudAccountsPage } from "../../web-templates/admin-pages.js";

export function registerCloudRoutes(app: H3, deps: AdminDeps): void {

  app.get("/admin/cloud-accounts", async (event) => {
    const user = event.context.user!;
    const accounts = await deps.repo.listCloudAccounts();
    const providers = listProviders();

    const vendors = CLOUD_VENDORS.map((v) => ({ value: v, label: VENDOR_LABELS[v] }));
    const credentialFields = providers.flatMap((p) =>
      p.credentialFields().map((f) => ({ vendor: p.vendor, ...f })),
    );

    return htmlPage(CloudAccountsPage({
      user: user.username,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        vendor: a.vendor,
        camera_count: a.camera_count,
        last_sync_at: a.last_sync_at,
        last_sync_error: a.last_sync_error,
      })),
      vendors,
      credentialFields,
    }));
  });

  app.post("/admin/cloud-accounts/add", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const vendor = (body?.["vendor"] ?? "").trim() as CloudVendor;
    const name = (body?.["name"] ?? "").trim();
    if (!CLOUD_VENDORS.includes(vendor) || !name) {
      throw createError({ statusCode: 400, statusMessage: "vendor + name required" });
    }

    const provider = getProvider(vendor);
    if (!provider) throw createError({ statusCode: 400, statusMessage: `unknown vendor ${vendor}` });

    // Extract credential fields.
    const creds: Record<string, string> = {};
    for (const f of provider.credentialFields()) {
      const v = (body?.[`cred_${f.name}`] ?? "").trim();
      if (f.required && !v) throw createError({ statusCode: 400, statusMessage: `${f.label} is required` });
      if (v) creds[f.name] = v;
    }

    // Test credentials.
    const test = await provider.testCredentials(creds);
    if (!test.ok) {
      throw createError({ statusCode: 400, statusMessage: `Credential test failed: ${test.error}` });
    }

    // Store encrypted.
    const encrypted = deps.secrets.encryptString(JSON.stringify(creds), "cloud-creds");
    await deps.repo.createCloudAccount({
      id: randomUUID(),
      vendor,
      name,
      credentials_encrypted: encrypted,
    });

    return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });
  });

  app.post("/admin/cloud-accounts/:id/sync", async (event) => {
    const id = String(getRouterParam(event, "id"));
    const account = await deps.repo.getCloudAccount(id);
    if (!account) return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });

    const provider = getProvider(account.vendor as CloudVendor);
    if (!provider) {
      await deps.repo.updateCloudAccount(id, { last_sync_error: "unknown vendor" });
      return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });
    }

    let creds: Record<string, string>;
    try {
      creds = JSON.parse(deps.secrets.decryptString(account.credentials_encrypted, "cloud-creds"));
    } catch {
      await deps.repo.updateCloudAccount(id, { last_sync_error: "credential decrypt failed" });
      return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });
    }

    try {
      const cameras = await provider.listCameras(creds);
      await deps.repo.updateCloudAccount(id, {
        camera_count: cameras.length,
        last_sync_at: new Date().toISOString(),
        last_sync_error: null,
      } as any);
    } catch (err) {
      await deps.repo.updateCloudAccount(id, {
        last_sync_error: (err as Error).message,
        last_sync_at: new Date().toISOString(),
      } as any);
    }

    return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });
  });

  app.post("/admin/cloud-accounts/:id/import", async (event) => {
    const id = String(getRouterParam(event, "id"));
    const account = await deps.repo.getCloudAccount(id);
    if (!account) return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });

    const provider = getProvider(account.vendor as CloudVendor);
    if (!provider) return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });

    let creds: Record<string, string>;
    try {
      creds = JSON.parse(deps.secrets.decryptString(account.credentials_encrypted, "cloud-creds"));
    } catch {
      return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });
    }

    const cameras = await provider.listCameras(creds);
    let imported = 0;
    for (const cam of cameras) {
      if (!cam.rtsp_url && !cam.relay_url) continue;
      // Check if already imported (by vendor_id in camera name prefix).
      const existingName = `${account.name}: ${cam.name}`;
      const existing = await deps.repo.getCameraByName(existingName);
      if (existing) continue;

      await deps.repo.createCamera({
        name: existingName,
        type: "rtsp",
        rtsp_url: cam.rtsp_url ?? cam.relay_url ?? null,
      });
      imported++;
    }

    await deps.repo.updateCloudAccount(id, {
      camera_count: cameras.length,
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
    } as any);

    return new Response(null, { status: 302, headers: { location: `/admin/cloud-accounts` } });
  });

  app.post("/admin/cloud-accounts/:id/delete", async (event) => {
    const id = String(getRouterParam(event, "id"));
    await deps.repo.deleteCloudAccount(id);
    return new Response(null, { status: 302, headers: { location: "/admin/cloud-accounts" } });
  });
}
