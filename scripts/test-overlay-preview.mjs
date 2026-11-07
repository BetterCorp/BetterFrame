import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { H3 } from "h3";
import { chromium } from "playwright";
import { registerOverlayRoutes } from "../server/src/plugins/service-admin-http/routes-overlays.ts";

const app = new H3();
registerOverlayRoutes(app, { repo: { listOverlayTemplates: async () => [] } });
const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith("/static/")) {
      const name = request.url.slice(8);
      if (!/^[a-z0-9.-]+$/.test(name)) { response.writeHead(404).end(); return; }
      const content = await readFile(new URL("../server/src/web-static/" + name, import.meta.url));
      response.setHeader("content-type", name.endsWith(".js") ? "application/javascript" : name.endsWith(".svg") ? "image/svg+xml" : "text/css");
      response.end(content); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await app.request("http://127.0.0.1" + request.url, {
      method: request.method, headers: request.headers,
      ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.BF_CHROMIUM_PATH ? { executablePath: process.env.BF_CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/admin/overlays`);
  const preview = page.frameLocator("#overlay-preview");
  await preview.locator(".fill").waitFor();
  async function fraction() {
    return preview.locator(".fill").evaluate(el => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width);
  }
  assert.ok(Math.abs(await fraction() - 0.64) < 0.01);
  async function data(progress) {
    const finished = page.waitForResponse(r => r.url().endsWith("/admin/overlays/preview") && r.request().method() === "POST");
    await page.locator("#overlay-sample").fill(JSON.stringify({ name: "Test", status: "Printing", progress }));
    await finished;
    await preview.getByText(`Test · Printing · ${progress}%`).waitFor();
  }
  for (const [value, expected] of [[0, 0], [25, .25], [150, 1], [-10, 0]]) {
    await data(value);
    assert.ok(Math.abs(await fraction() - expected) < .01, `${value}: incorrect bar width`);
  }
  await data(64);
  await page.selectOption("#overlay-size", "240,480");
  const dimensions = await preview.locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.equal(dimensions.width, 240);
  assert.equal(dimensions.height, 480);
  await page.locator("#overlay-sample").fill("{broken");
  await page.waitForFunction(() => document.getElementById("overlay-preview-error").textContent.length > 0);
  assert.ok(Math.abs(await fraction() - .64) < .01, "invalid JSON should retain the last valid preview");
  await data(64);
  let assetRequests = 0;
  await page.route("https://overlay-test.invalid/pixel.png", route => {
    assetRequests++;
    return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64") });
  });
  const assetResponse = page.waitForResponse("https://overlay-test.invalid/pixel.png");
  const hostBackground = await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor);
  const html = await page.locator("#overlay-html").inputValue();
  const finished = page.waitForResponse(r => r.url().endsWith("/admin/overlays/preview") && r.request().method() === "POST");
  await page.locator("#overlay-html").fill(html + '<style>body{background:red}.main-wrap{display:none}</style><script>parent.overlayEscaped=true;document.body.dataset.executed="yes"</script><p id="isolated">Isolated</p><img src="https://overlay-test.invalid/pixel.png" />');
  await finished;
  await preview.locator("#isolated").waitFor();
  await assetResponse;
  assert.equal(assetRequests, 1, "preview resource policy should match playback");
  assert.equal(await page.evaluate(() => window.overlayEscaped), undefined);
  assert.equal(await preview.locator("body").getAttribute("data-executed"), null);
  assert.equal(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), hostBackground);
  assert.equal(await page.locator(".main-wrap").isVisible(), true);
  assert.equal(await page.locator("#overlay-preview").getAttribute("sandbox"), "");
  const restored = page.waitForResponse(r => r.url().endsWith("/admin/overlays/preview") && r.request().method() === "POST");
  await page.locator("#overlay-html").fill(html);
  await restored;
  await preview.locator("#isolated").waitFor({ state: "detached" });
  await page.selectOption("#overlay-size", "640,360");
  await page.screenshot({ path: process.env.BF_OVERLAY_SCREENSHOT || "/tmp/betterframe-overlay-preview.png", fullPage: true });
  console.log("Overlay browser checks passed: live data, progress math/clamping, responsive viewport, invalid JSON recovery, CSS isolation, script isolation.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
