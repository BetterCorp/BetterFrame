import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { effectiveFirmwareChannel, kioskDebugEnabled } from "../src/shared/kiosk-channels.js";
import { KioskEditPage, KioskFirmwarePanel } from "../src/web-templates/admin-pages.js";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";
import { registerKioskRoutes } from "../src/plugins/service-api-http/index.js";
import type { Kiosk } from "../src/shared/types.js";

for (const managed_image of [true, false]) {
  for (const firmware_channel of ["stable", "beta", "dev"] as const) {
    for (const os_update_channel of ["stable", "beta", "dev"] as const) {
      test(`debug channel policy: managed=${managed_image}, app=${firmware_channel}, OS=${os_update_channel}`, async () => {
        const kiosk = { id: "k1", name: "Lobby", enabled: true, capabilities: ["linux"], managed_image, firmware_channel, os_update_channel } as Kiosk;
        const enabled = os_update_channel === "dev" && (managed_image || firmware_channel === "dev");
        assert.equal(effectiveFirmwareChannel(kiosk), managed_image ? os_update_channel : firmware_channel);
        assert.equal(kioskDebugEnabled(kiosk), enabled);
        const html = String(KioskEditPage({ user: "admin", kiosk, labels: [], allLabels: [], displayLayouts: [] }));
        assert.equal(html.includes('href="/admin/kiosks/k1/logs"'), enabled);
        if (managed_image) assert.match(String(KioskFirmwarePanel({kiosk, releases: []})), /linked to OS/);

        const app = new H3();
        let totp = true;
        app.use(event => { event.context.user = { username: "admin", totp_enabled: totp } as never; });
        registerAdminRoutes(app, { repo: { getKioskById: async () => kiosk } } as never);
        for (const page of ["logs", "terminal"]) {
          const response = await app.request(`http://bf.test/admin/kiosks/k1/${page}`);
          assert.equal((await response.text()).includes("Unavailable"), !enabled);
          totp = false;
          assert.equal((await app.request(`http://bf.test/admin/kiosks/k1/${page}`)).status, 403);
          totp = true;
        }

        const heartbeat = new H3();
        heartbeat.use(event => { event.context.verifiedKiosk = {id: "k1"}; });
        registerKioskRoutes(heartbeat, {
          getKioskById: async () => kiosk, touchKiosk: async () => {}, getSetupExtra: async () => null, listDisplaysForKiosk: async () => [],
        } as never, {} as never, {} as never, {} as never, {} as never, {} as never,
        {publishTelemetry() {}} as never, "");
        const response = await heartbeat.request("http://bf.test/api/kiosk/heartbeat", {
          method: "POST", headers: {"content-type": "application/json"}, body: "{}",
        });
        assert.equal(response.status, 200);
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.firmware_channel, managed_image ? os_update_channel : firmware_channel);
        assert.equal(body.os_update_channel, os_update_channel);
        // Installed clients require both fields to be dev. No client upgrade needed.
        assert.equal(body.firmware_channel === "dev" && body.os_update_channel === "dev", enabled);
      });
    }
  }
}
