import assert from "node:assert/strict";
import test from "node:test";

import { debugHtmlPage } from "../src/plugins/service-admin-http/html-response.js";
import { operatorMayAccess } from "../src/plugins/service-admin-http/middleware.js";
import { requestOriginIsValid } from "../src/shared/csrf.js";
import {
  createOnvifCallbackToken,
  onvifCallbackTokenMatches,
} from "../src/shared/onvif-callback-token.js";

test("debug HTML permits only its generated script nonce", async () => {
  const response = debugHtmlPage("<script>window.test = true</script>");
  const body = await response.text();
  const nonce = body.match(/<script nonce="([^"]+)">/)?.[1];
  const policy = response.headers.get("content-security-policy") ?? "";

  assert.ok(nonce);
  assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce}'`));
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
});

test("ONVIF callback tokens reject tampering and cross-camera reuse", () => {
  const secrets = { deriveKey: () => Buffer.alloc(32, 9) };
  const first = createOnvifCallbackToken(secrets as never, "camera-a", "fixed-nonce");
  const second = createOnvifCallbackToken(secrets as never, "camera-b", "fixed-nonce");

  assert.equal(onvifCallbackTokenMatches(first.token, first.hash), true);
  assert.equal(onvifCallbackTokenMatches(`${first.token}x`, first.hash), false);
  assert.equal(onvifCallbackTokenMatches(first.token, second.hash), false);
});

test("operator access defaults closed for privileged and new admin routes", () => {
  assert.equal(operatorMayAccess("/admin/displays/display-a", "GET"), true);
  assert.equal(operatorMayAccess("/admin/displays/display-a/layout/layout-a", "POST"), true);
  assert.equal(operatorMayAccess("/admin/kiosks/kiosk-a/logs", "GET"), false);
  assert.equal(operatorMayAccess("/admin/users", "GET"), false);
  assert.equal(operatorMayAccess("/admin/future-feature", "GET"), false);
  assert.equal(operatorMayAccess("/admin/layouts/layout-a/delete", "POST"), false);
});

test("browser state changes reject cross-origin requests", () => {
  const event = (origin: string, site: string) => ({
    req: new Request("https://frame.example/setup", {
      headers: { host: "frame.example", origin, "sec-fetch-site": site },
    }),
  });
  assert.equal(requestOriginIsValid(event("https://frame.example", "same-origin") as never), true);
  assert.equal(requestOriginIsValid(event("https://attacker.example", "cross-site") as never), false);
});
