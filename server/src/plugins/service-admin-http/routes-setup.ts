/**
 * First-run setup routes.
 *
 * GET  /setup — render setup form
 * POST /setup — create admin user, provision cluster key, create default display
 */
import { type H3, readBody, html } from "h3";
import type { AdminDeps } from "./index.js";
import { SetupPage } from "../../web-templates/auth-pages.js";

export function registerSetupRoutes(app: H3, deps: AdminDeps): void {
  app.get("/setup", () => {
    if (deps.store.repo.isSetupComplete()) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }
    return html(SetupPage({}));
  });

  app.post("/setup", async (event) => {
    if (deps.store.repo.isSetupComplete()) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }

    const body = await readBody<{ username?: string; password?: string }>(event);
    const username = (body?.username ?? "").trim();
    const password = body?.password ?? "";
    const errors: string[] = [];

    // Validate
    if (!username || username.length < 3 || username.length > 64) {
      errors.push("Username must be 3–64 characters.");
    } else if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      errors.push("Username may only contain letters, digits, underscore, or hyphen.");
    }
    if (password.length < 12) {
      errors.push("Password must be at least 12 characters.");
    }

    if (errors.length > 0) {
      return html(SetupPage({ error: errors.join(" "), username }));
    }

    // Create admin user
    const hash = await deps.auth.hashPassword(password);
    deps.store.repo.createUser({ username, password_hash: hash, role: "admin" });

    // Provision cluster key
    const clusterKey = deps.secrets.generateClusterKey();
    const encryptedCluster = deps.secrets.encryptString(clusterKey, "cluster");
    deps.store.repo.setSetupExtra("cluster_key_encrypted", encryptedCluster);
    deps.store.repo.markClusterKeyProvisioned();

    // Create default display
    deps.store.repo.createDefaultDisplay();

    // Mark setup complete
    deps.store.repo.markSetupComplete();

    return new Response(null, {
      status: 302,
      headers: { location: "/auth/login?welcome=1" },
    });
  });
}
