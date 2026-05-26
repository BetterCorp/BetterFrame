/**
 * First-run setup routes.
 */
import { type H3, readBody } from "h3";
import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { SetupPage } from "../../web-templates/auth-pages.js";
import { SetupBody, validateBody } from "../../shared/api-schemas.js";

export function registerSetupRoutes(app: H3, deps: AdminDeps): void {
  app.get("/setup", async () => {
    if (await deps.repo.isSetupComplete()) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }
    return htmlPage(SetupPage({}));
  });

  app.post("/setup", async (event) => {
    if (await deps.repo.isSetupComplete()) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }

    let body: { username: string; password: string };
    try {
      body = validateBody(SetupBody, await readBody(event));
    } catch {
      return htmlPage(SetupPage({ error: "Username (3-64 chars) and password (12+ chars) required.", username: "" }));
    }
    const username = body.username.trim();
    const password = body.password;
    const errors: string[] = [];

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      errors.push("Username may only contain letters, digits, underscore, or hyphen.");
    }

    if (errors.length > 0) {
      return htmlPage(SetupPage({ error: errors.join(" "), username }));
    }

    const hash = await deps.auth.hashPassword(password);
    await deps.repo.createUser({ username, password_hash: hash, role: "admin" });

    const clusterKey = deps.secrets.generateClusterKey();
    const encryptedCluster = deps.secrets.encryptString(clusterKey, "cluster");
    await deps.repo.setSetupExtra("cluster_key_encrypted", encryptedCluster);
    await deps.repo.markClusterKeyProvisioned();

    // Setup only creates admin user + cluster key.
    // Displays are created when kiosks are paired (kiosk reports HDMI ports).
    // Layouts are created by admin after pairing.
    await deps.repo.markSetupComplete();

    return new Response(null, {
      status: 302,
      headers: { location: "/auth/login?welcome=1" },
    });
  });
}
