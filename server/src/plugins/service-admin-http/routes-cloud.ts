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

export function registerCloudRoutes(app: H3, deps: AdminDeps): void {

  app.get("/admin/cloud-accounts", async (event) => {
    const user = event.context.user!;
    const accounts = await deps.repo.listCloudAccounts();
    const providers = listProviders();

    return htmlPage(`<html><head><title>Cloud Accounts</title>
      <link rel="stylesheet" href="/static/app.css">
      </head><body style="font-family:system-ui;max-width:900px;margin:2rem auto;padding:0 1rem">
      <h1>Cloud Camera Accounts</h1>
      <p style="color:#666">Link your camera vendor cloud accounts. Server syncs cameras + delivers streaming URLs to kiosks. Credentials stored encrypted — never leave the server.</p>

      <div style="background:#f9fafb;border:1px solid #ddd;border-radius:6px;padding:1rem;margin-bottom:2rem">
        <h2 style="margin:0 0 1rem;font-size:1.1rem">Add Account</h2>
        <form method="post" action="/admin/cloud-accounts/add" style="display:grid;gap:0.75rem">
          <div>
            <label style="font-size:0.85rem;font-weight:600">Vendor</label>
            <select name="vendor" class="form-input" required>
              ${CLOUD_VENDORS.map((v) => `<option value="${v}">${VENDOR_LABELS[v]}</option>`).join("")}
            </select>
          </div>
          <div>
            <label style="font-size:0.85rem;font-weight:600">Account Name</label>
            <input name="name" type="text" class="form-input" required placeholder="e.g. Main Office Hik-Connect" />
          </div>
          <div id="cred-fields">
            ${providers.map((p) => p.credentialFields().map((f) =>
              `<div data-vendor="${p.vendor}" style="display:none;margin-bottom:0.5rem">
                <label style="font-size:0.85rem">${f.label}${f.required ? ' *' : ''}</label>
                <input name="cred_${f.name}" type="${f.type}" class="form-input" ${f.required ? 'required' : ''} />
              </div>`
            ).join("")).join("")}
          </div>
          <button type="submit" class="btn btn-primary">Add + Test</button>
        </form>
        <script>
          document.querySelector('[name="vendor"]').addEventListener('change', function() {
            var v = this.value;
            document.querySelectorAll('#cred-fields [data-vendor]').forEach(function(el) {
              el.style.display = el.getAttribute('data-vendor') === v ? '' : 'none';
              el.querySelectorAll('input').forEach(function(inp) {
                inp.required = el.getAttribute('data-vendor') === v && inp.closest('[data-vendor]').querySelector('label').textContent.includes('*');
              });
            });
          });
          document.querySelector('[name="vendor"]').dispatchEvent(new Event('change'));
        </script>
      </div>

      <h2 style="font-size:1.1rem">Linked Accounts</h2>
      ${accounts.length === 0
        ? '<p style="color:#999">No cloud accounts linked yet.</p>'
        : `<table style="width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="text-align:left;padding:0.5rem;border-bottom:2px solid #ddd">Name</th>
              <th style="text-align:left;padding:0.5rem;border-bottom:2px solid #ddd">Vendor</th>
              <th style="text-align:left;padding:0.5rem;border-bottom:2px solid #ddd">Cameras</th>
              <th style="text-align:left;padding:0.5rem;border-bottom:2px solid #ddd">Last Sync</th>
              <th style="padding:0.5rem;border-bottom:2px solid #ddd"></th>
            </tr></thead>
            <tbody>
              ${accounts.map((a) => `<tr>
                <td style="padding:0.5rem;border-bottom:1px solid #eee"><strong>${a.name}</strong></td>
                <td style="padding:0.5rem;border-bottom:1px solid #eee">${VENDOR_LABELS[a.vendor as CloudVendor] ?? a.vendor}</td>
                <td style="padding:0.5rem;border-bottom:1px solid #eee">${a.camera_count}</td>
                <td style="padding:0.5rem;border-bottom:1px solid #eee;font-size:0.85rem">
                  ${a.last_sync_at ?? '—'}
                  ${a.last_sync_error ? `<br><span style="color:#c00;font-size:0.8rem">${a.last_sync_error}</span>` : ''}
                </td>
                <td style="padding:0.5rem;border-bottom:1px solid #eee">
                  <form method="post" action="/admin/cloud-accounts/${a.id}/sync" style="display:inline">
                    <button type="submit" class="btn btn-sm">Sync</button>
                  </form>
                  <form method="post" action="/admin/cloud-accounts/${a.id}/import" style="display:inline;margin-left:0.25rem">
                    <button type="submit" class="btn btn-sm btn-primary">Import</button>
                  </form>
                  <form method="post" action="/admin/cloud-accounts/${a.id}/delete" style="display:inline;margin-left:0.25rem"
                    onsubmit="return confirm('Delete this cloud account?')">
                    <button type="submit" class="btn btn-sm btn-danger">Delete</button>
                  </form>
                </td>
              </tr>`).join("")}
            </tbody>
          </table>`
      }
      <p style="margin-top:1rem"><a href="/admin/cameras">← Back to Cameras</a></p>
    </body></html>`);
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
