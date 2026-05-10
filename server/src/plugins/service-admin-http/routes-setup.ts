/**
 * First-run setup routes.
 */
import { type H3, readBody } from "h3";
import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { SetupPage } from "../../web-templates/auth-pages.js";

export function registerSetupRoutes(app: H3, deps: AdminDeps): void {
  app.get("/setup", () => {
    if (deps.repo.isSetupComplete()) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }
    return htmlPage(SetupPage({}));
  });

  app.post("/setup", async (event) => {
    if (deps.repo.isSetupComplete()) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }

    const body = await readBody<{ username?: string; password?: string }>(event);
    const username = (body?.username ?? "").trim();
    const password = body?.password ?? "";
    const errors: string[] = [];

    if (!username || username.length < 3 || username.length > 64) {
      errors.push("Username must be 3–64 characters.");
    } else if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      errors.push("Username may only contain letters, digits, underscore, or hyphen.");
    }
    if (password.length < 12) {
      errors.push("Password must be at least 12 characters.");
    }

    if (errors.length > 0) {
      return htmlPage(SetupPage({ error: errors.join(" "), username }));
    }

    const hash = await deps.auth.hashPassword(password);
    deps.repo.createUser({ username, password_hash: hash, role: "admin" });

    const clusterKey = deps.secrets.generateClusterKey();
    const encryptedCluster = deps.secrets.encryptString(clusterKey, "cluster");
    deps.repo.setSetupExtra("cluster_key_encrypted", encryptedCluster);
    deps.repo.markClusterKeyProvisioned();

    deps.repo.createDefaultDisplay();
    deps.repo.markSetupComplete();

    return new Response(null, {
      status: 302,
      headers: { location: "/auth/login?welcome=1" },
    });
  });
}
