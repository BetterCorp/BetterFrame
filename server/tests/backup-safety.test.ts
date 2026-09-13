import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";

test("legacy backup routes reject before touching uploads, storage or keys", async () => {
  const app = new H3();
  const forbidden = new Proxy({}, { get: () => { throw new Error("backup touched deployment state"); } });
  registerAdminRoutes(app, forbidden as never);
  for (const action of ["download", "restore"]) {
    const response = await app.fetch(new Request(`http://localhost/admin/backup/${action}`, {
      method: "POST", body: "not a valid backup archive",
    }));
    assert.equal(response.status, 409);
    assert.match(await response.text(), /PostgreSQL/);
  }
});
