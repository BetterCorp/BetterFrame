import { type H3, assertBodySize, getRouterParam, readBody } from "h3";
import { uuidv7 } from "uuidv7";
import type { AdminDeps } from "./index.js";
import { htmlPage } from "./html-response.js";
import { audit } from "../../shared/audit.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import { MAX_CA_BYTES, parseTrustedCa, trustedCaAssignment } from "../../shared/trusted-cas.js";
import { TrustedCasPage } from "../../web-templates/trusted-ca-pages.js";

export function registerTrustedCaRoutes(app: H3, deps: AdminDeps): void {
  const notify = () => { try { getCoordinator().notifyBundleChanged(); } catch { /* next polling sync */ } };
  const redirect = () => new Response(null, { status: 303, headers: { location: "/admin/trusted-cas" } });
  const page = async (user?: string, error?: string) => htmlPage(TrustedCasPage({ user, error,
    cas: await deps.repo.listTrustedCas(), kiosks: await deps.repo.listKiosks(),
    assignments: await deps.repo.listTrustedCaAssignments(), reports: await deps.repo.listTrustedCaReports() }));
  app.get("/admin/trusted-cas", event => page(event.context.user?.username));
  app.post("/admin/trusted-cas", async event => {
    await assertBodySize(event, 32 * 1024);
    try {
      let name: unknown, input: Uint8Array | string;
      if (event.req.headers.get("content-type")?.startsWith("multipart/form-data")) {
        const form = await event.req.formData();
        name = form.get("name");
        const file = form.get("certificate");
        if (!(file instanceof File) || file.size > MAX_CA_BYTES) throw new Error("Upload a PEM or DER certificate up to 16 KiB");
        input = new Uint8Array(await file.arrayBuffer());
      } else {
        const body = await readBody<Record<string, unknown>>(event);
        name = body?.["name"];
        if (typeof body?.["pem"] !== "string") throw new Error("A PEM certificate is required");
        input = body["pem"];
      }
      if (typeof name !== "string" || !name.trim() || name.trim().length > 128) throw new Error("Name must contain 1–128 characters");
      const parsed = parseTrustedCa(input);
      const ca = { id: uuidv7(), name: name.trim(), ...parsed };
      const persisted = await deps.repo.saveTrustedCa(ca);
      await audit(deps.repo, event, "trusted-ca.upload", { resource_type: "trusted_ca", resource_id: persisted.id, metadata: { fingerprint_sha256: persisted.fingerprint_sha256 } });
      return redirect();
    } catch (cause) {
      const response = await page(event.context.user?.username, cause instanceof Error ? cause.message : "Invalid certificate");
      return new Response(response.body, { status: 422, headers: response.headers });
    }
  });
  app.get("/admin/trusted-cas/:id/certificate", async event => {
    const ca = await deps.repo.getTrustedCa(getRouterParam(event, "id") ?? "");
    return ca ? new Response(ca.pem, { headers: { "content-type": "application/x-x509-ca-cert", "content-disposition": `attachment; filename="betterframe-${ca.fingerprint_sha256}.crt"`, "cache-control": "no-store" } }) : new Response("Certificate not found", { status: 404 });
  });
  app.post("/admin/trusted-cas/:id/delete", async event => {
    const id = getRouterParam(event, "id") ?? "";
    const ca = await deps.repo.getTrustedCa(id);
    if (!ca) return new Response("Certificate not found", { status: 404 });
    await deps.repo.deleteTrustedCa(id);
    await audit(deps.repo, event, "trusted-ca.delete", { resource_type: "trusted_ca", resource_id: id, metadata: { fingerprint_sha256: ca.fingerprint_sha256 } });
    notify(); return redirect();
  });
  app.post("/admin/trusted-cas/players/:id", async event => {
    await assertBodySize(event, 16 * 1024);
    const id = getRouterParam(event, "id") ?? "";
    if (!await deps.repo.getKioskById(id)) return new Response("Player not found", { status: 404 });
    try {
      const body = await readBody<Record<string, unknown>>(event);
      const ids = trustedCaAssignment(body?.["ca_ids"]);
      for (const caId of ids) {
        const ca = await deps.repo.getTrustedCa(caId);
        if (!ca) throw new Error("Certificate not found in this tenant");
        parseTrustedCa(ca.pem);
      }
      await deps.repo.assignTrustedCas(id, ids);
      await audit(deps.repo, event, "trusted-ca.assign", { resource_type: "kiosk", resource_id: id, metadata: { ca_ids: ids } });
      notify(); return redirect();
    } catch (cause) {
      const response = await page(event.context.user?.username, cause instanceof Error ? cause.message : "Invalid assignment");
      return new Response(response.body, { status: 422, headers: response.headers });
    }
  });
}
