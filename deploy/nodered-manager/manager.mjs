import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { copyFile, mkdir, readFile, rename, writeFile, chmod, chown } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";

const DATA = process.env.BF_NODERED_DATA || "/data";
const STATE_FILE = join(DATA, "manager-state.json");
const MANAGER_TOKEN = process.env.BF_NODERED_MANAGER_SECRET
  || (process.env.BF_NODERED_MANAGER_SECRET_FILE ? readFileSync(process.env.BF_NODERED_MANAGER_SECRET_FILE, "utf8").trim() : "");
const MAX_TENANTS = Number(process.env.BF_NODERED_MAX_TENANTS || 50);
const MEMORY_MB = Number(process.env.BF_NODERED_TENANT_MEMORY_MB || 256);
const PORT = Number(process.env.PORT || 1880);
const EASY1_READINESS_CONTRACT = 1;
const NODE_RED = process.env.BF_NODE_RED_SCRIPT || "/usr/src/node-red/node_modules/node-red/red.js";
const runtimes = new Map();
const dashboardRoots = new Map();
let state = { nextUid: 20000, tenants: {} };

if (MANAGER_TOKEN.length < 32) throw new Error("BF_NODERED_MANAGER_SECRET must be at least 32 characters");

function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function authorized(req) {
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(MANAGER_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function loadState() {
  await mkdir(join(DATA, "tenants"), { recursive: true });
  await mkdir(join(DATA, "archive"), { recursive: true });
  if (existsSync(STATE_FILE)) state = JSON.parse(await readFile(STATE_FILE, "utf8"));
}

async function saveState() {
  const temp = `${STATE_FILE}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, STATE_FILE);
  await chmod(STATE_FILE, 0o600);
}

function dashboardToken(tenant) {
  return createHmac("sha256", tenant.adminToken).update("dashboard-access-v1").digest("hex");
}

function settingsSource(tenant) {
  return `module.exports = ${JSON.stringify({
    uiHost: "127.0.0.1",
    uiPort: tenant.port,
    userDir: tenant.userDir,
    flowFile: "flows.json",
    credentialSecret: tenant.credentialSecret,
    httpAdminRoot: "/nrdp",
    httpNodeRoot: "/",
    nodesDir: ["/usr/src/betterframe-nodes"],
    functionGlobalContext: {},
  }, null, 2)};
module.exports.httpAdminMiddleware = function(req,res,next) {
  if (req.headers["x-betterframe-runtime-token"] !== ${JSON.stringify(tenant.adminToken)}) {
    res.statusCode = 403; return res.end("forbidden");
  }
  next();
};
// Public HTTP-in routes must never grant dashboard access, including custom
// dashboard roots and Socket.IO connections. This credential is dashboard-only.
const dashboardAllowed = (req) => req.headers["x-betterframe-dashboard-token"] === ${JSON.stringify(dashboardToken(tenant))};
module.exports.dashboard = {
  middleware(req, res, next) {
    if (!dashboardAllowed(req)) { res.statusCode = 403; return res.end("forbidden"); }
    res.setHeader("Cache-Control", "no-store");
    next();
  },
  ioMiddleware(socket, next) {
    next(dashboardAllowed(socket.request) ? undefined : new Error("forbidden"));
  },
};
module.exports.ui = module.exports.dashboard;
`;
}

function nextPort() {
  const used = new Set(Object.values(state.tenants).map((tenant) => tenant.port));
  for (let port = 19000; port < 19000 + MAX_TENANTS; port++) if (!used.has(port)) return port;
  throw new Error("tenant runtime port limit reached");
}

function validTenantId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
}

function publicRuntimePath(path) {
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  // Reject ambiguous encodings and normalize before checking reserved paths.
  if (/[\\%\x00-\x1f]/.test(decoded) || decoded.startsWith("//")) return null;
  const canonical = new URL(decoded, "http://localhost").pathname.replace(/\/+/g, "/");
  return /^\/(?:nrdp|_betterframe|dash|dashboard|ui)(?:\/|$)/i.test(canonical)
    || /^\/api\/internal(?:\/|$)/i.test(canonical) ? null : canonical;
}

function runtimeEnvironment(tenant) {
  const env = { ...process.env, HOME: tenant.userDir, USER: `bf-nodered-${tenant.uid}`, PORT: String(tenant.port),
    BF_NODERED_INTERNAL_TOKEN: tenant.adminToken };
  delete env.BF_NODERED_MANAGER_SECRET;
  delete env.BF_NODERED_MANAGER_SECRET_FILE;
  return env;
}

async function ensureTenant(input) {
  if (!validTenantId(input.tenant_id)) throw new Error("invalid tenant id");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.slug || "")) throw new Error("invalid tenant slug");
  if (typeof input.server_url !== "string" || !/^https?:\/\//.test(input.server_url)) throw new Error("invalid server url");
  if (typeof input.api_key !== "string" || input.api_key.length < 16) throw new Error("invalid API key");
  const duplicateSlug = Object.values(state.tenants).find(
    (tenant) => tenant.slug === input.slug && tenant.tenant_id !== input.tenant_id,
  );
  if (duplicateSlug) throw new Error("tenant slug already exists");
  const existing = state.tenants[input.tenant_id];
  if (!existing && Object.keys(state.tenants).length >= MAX_TENANTS) throw new Error("tenant runtime limit reached");
  const tenant = existing || {
    uid: state.nextUid++,
    gid: state.nextUid - 1,
    port: nextPort(),
    credentialSecret: secret(),
    adminToken: secret(),
    userDir: join(DATA, "tenants", input.tenant_id),
  };
  Object.assign(tenant, {
    tenant_id: input.tenant_id,
    slug: input.slug,
    name: input.name,
    active: input.active === true,
    server_url: input.server_url,
    api_key: input.api_key,
  });
  if (!existing && tenant.slug === "default") await migrateLegacyDefault(tenant);
  state.tenants[input.tenant_id] = tenant;
  await saveState();
  if (tenant.active) await startRuntime(tenant);
  else await stopRuntime(input.tenant_id);
  return tenant;
}

async function migrateLegacyDefault(tenant) {
  if (existsSync(tenant.userDir)) return;
  await mkdir(tenant.userDir, { recursive: true, mode: 0o700 });
  const legacyRuntime = join(DATA, ".config.runtime.json");
  if (existsSync(legacyRuntime)) {
    try {
      const config = JSON.parse(await readFile(legacyRuntime, "utf8"));
      if (typeof config._credentialSecret === "string" && config._credentialSecret) {
        tenant.credentialSecret = config._credentialSecret;
      }
    } catch {}
  }
  for (const name of ["flows.json", "flows_cred.json", ".config.runtime.json"]) {
    const source = join(DATA, name);
    if (!existsSync(source)) continue;
    const target = join(tenant.userDir, name);
    await copyFile(source, target);
    await chmod(target, 0o600);
    await chown(target, tenant.uid, tenant.gid);
  }
  await chown(tenant.userDir, tenant.uid, tenant.gid);
}

async function startRuntime(tenant) {
  const current = runtimes.get(tenant.tenant_id);
  if (current?.child && current.child.exitCode === null) {
    void syncConfig(tenant);
    return;
  }
  await mkdir(tenant.userDir, { recursive: true, mode: 0o700 });
  const settings = join(tenant.userDir, "settings.js");
  await writeFile(settings, settingsSource(tenant), { mode: 0o600 });
  await chown(tenant.userDir, tenant.uid, tenant.gid);
  await chown(settings, tenant.uid, tenant.gid);
  dashboardRoots.delete(tenant.tenant_id);
  const runtime = { tenant, child: null, restartDelay: current?.restartDelay || 1000, stopping: false };
  runtimes.set(tenant.tenant_id, runtime);
  const child = spawn(process.execPath, [`--max-old-space-size=${MEMORY_MB}`, NODE_RED, "--userDir", tenant.userDir, "--settings", settings], {
    uid: tenant.uid,
    gid: tenant.gid,
    env: runtimeEnvironment(tenant),
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtime.child = child;
  child.stdout.on("data", (chunk) => process.stdout.write(`[${tenant.slug}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${tenant.slug}] ${chunk}`));
  child.on("exit", () => {
    runtime.child = null;
    if (!runtime.stopping && state.tenants[tenant.tenant_id]?.active) {
      setTimeout(() => void startRuntime(tenant), runtime.restartDelay);
      runtime.restartDelay = Math.min(runtime.restartDelay * 2, 30000);
    }
  });
  void waitForRuntime(tenant).then(() => {
    runtime.restartDelay = 1000;
    return syncConfig(tenant);
  }).catch((error) => console.error(`[${tenant.slug}] startup failed: ${error.message}`));
}

async function stopRuntime(tenantId) {
  const runtime = runtimes.get(tenantId);
  if (!runtime?.child) return;
  runtime.stopping = true;
  runtime.child.kill("SIGTERM");
  const child = runtime.child;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  runtimes.delete(tenantId);
}

async function deleteTenant(tenantId) {
  const tenant = state.tenants[tenantId];
  if (!tenant) return;
  await stopRuntime(tenantId);
  if (existsSync(tenant.userDir)) {
    await rename(tenant.userDir, join(DATA, "archive", `${tenantId}-${Date.now()}`));
  }
  delete state.tenants[tenantId];
  await saveState();
}

async function waitForRuntime(tenant) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await probeRuntime(tenant)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Node-RED health timeout");
}

async function probeRuntime(tenant, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${tenant.port}/nrdp/flows`, {
      headers: { "x-betterframe-runtime-token": tenant.adminToken },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function runningChild(runtime) {
  const child = runtime?.child;
  return !runtime?.stopping && child?.pid > 0 && child.exitCode === null
    && child.signalCode === null && !child.killed;
}

async function runtimeReady(tenant, timeoutMs) {
  const runtime = runtimes.get(tenant.tenant_id);
  if (!runningChild(runtime)) return false;
  const child = runtime.child;
  if (!(await probeRuntime(tenant, timeoutMs))) return false;
  // An old process answering just before it exits must not qualify its replacement.
  return runtimes.get(tenant.tenant_id) === runtime && runtime.child === child && runningChild(runtime);
}

async function readiness(timeoutMs) {
  const expected = Object.values(state.tenants).filter((tenant) => tenant.active);
  const checks = await Promise.all(expected.map((tenant) => runtimeReady(tenant, timeoutMs)));
  const ready = checks.filter(Boolean).length;
  const current = Object.values(state.tenants).filter((tenant) => tenant.active);
  const unchanged = current.length === expected.length
    && current.every((tenant) => expected.includes(tenant));
  return { contract: EASY1_READINESS_CONTRACT,
    status: unchanged && ready === expected.length ? "ready" : "not_ready", expected: current.length, ready };
}

// Accept only unambiguous same-origin paths; IDs and names are not URL paths.
function dashboardPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\\%?#\x00-\x20]/.test(value) || value.includes("//")) return null;
  const path = value.replace(/\/$/, "");
  if (!path || path.split("/").some((part) => part === "." || part === "..")) return null;
  return path;
}

function dashboardPages(flows) {
  const bases = new Map(flows.filter((node) => node.type === "ui-base").map((node) => [node.id, dashboardPath(node.path)]));
  return flows.filter((node) => node.type === "ui-page").flatMap((node) => {
    const basePath = bases.get(node.ui);
    const pagePath = dashboardPath(node.path);
    if (!basePath || !pagePath || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(node.id)) return [];
    return [{ id: node.id, name: node.name || node.id, hidden: node.visible === false,
      basePath, path: basePath + pagePath }];
  });
}

// Public webhooks use a small per-runtime root cache, never a full flow fetch
// on the hot path. Invalidate before every editor mutation and config deploy;
// public requests fail closed until the mutation completes and discovery succeeds.
function rootCache(tenant) {
  if (!dashboardRoots.has(tenant.tenant_id)) {
    dashboardRoots.set(tenant.tenant_id, { roots: null, loading: null, generation: 0, mutations: 0, retryAfter: 0 });
  }
  return dashboardRoots.get(tenant.tenant_id);
}

function changingFlows(tenant) {
  const cache = rootCache(tenant);
  const invalidate = () => { cache.generation++; cache.roots = null; cache.loading = null; cache.retryAfter = 0; };
  cache.mutations++;
  invalidate();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    cache.mutations--;
    invalidate();
  };
}

async function publicDashboardRequest(req, tenant) {
  if (!req.bfPublic) return false;
  const cache = rootCache(tenant);
  if (cache.mutations || cache.retryAfter > Date.now()) return true;
  if (!cache.roots) {
    if (!cache.loading) {
      const generation = cache.generation;
      cache.loading = runtimeFlows(tenant).then((flows) => {
        if (cache.generation === generation) {
          cache.roots = flows.filter((node) => node.type === "ui-base").map((node) => dashboardPath(node.path));
        }
      }).catch(() => {
        if (cache.generation === generation) cache.retryAfter = Date.now() + 1000;
      }).finally(() => {
        if (cache.generation === generation) cache.loading = null;
      });
    }
    await cache.loading;
  }
  if (cache.mutations || !cache.roots) return true;
  const path = new URL(req.url, "http://localhost").pathname;
  // Socket.IO transport handshakes precede connection middleware.
  return cache.roots.some((base) => !base || path === base || path.startsWith(`${base}/`));
}

async function runtimeFlows(tenant) {
  const response = await fetch(`http://127.0.0.1:${tenant.port}/nrdp/flows`, {
    headers: { "x-betterframe-runtime-token": tenant.adminToken },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`dashboard discovery returned ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : data.flows || [];
}

async function syncConfig(tenant) {
  const headers = {
    "x-betterframe-runtime-token": tenant.adminToken,
    "node-red-api-version": "v2",
    accept: "application/json",
  };
  const response = await fetch(`http://127.0.0.1:${tenant.port}/nrdp/flows`, { headers });
  if (!response.ok) throw new Error(`GET flows returned ${response.status}`);
  const raw = await response.json();
  const flows = Array.isArray(raw) ? raw : raw.flows || [];
  const desired = {
    id: "bfsrv-default",
    type: "bf-server-config",
    name: `BetterFrame (${tenant.name})`,
    server_url: tenant.server_url.replace(/\/+$/, ""),
    tenant_slug: tenant.slug,
    tenant_name: tenant.name,
    managed_by_betterframe: true,
    managed_tenant_state: "active",
    credentials: { api_key: tenant.api_key },
  };
  const index = flows.findIndex((node) => node.id === desired.id && node.type === desired.type);
  if (index >= 0) flows[index] = { ...flows[index], ...desired };
  else flows.push(desired);
  const body = { flows, ...(Array.isArray(raw) || !raw.rev ? {} : { rev: raw.rev }) };
  const finishChange = changingFlows(tenant);
  try {
    const updated = await fetch(`http://127.0.0.1:${tenant.port}/nrdp/flows`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "node-red-deployment-type": "full" },
      body: JSON.stringify(body),
    });
    if (!updated.ok) throw new Error(`POST flows returned ${updated.status}`);
  } finally { finishChange(); }
}

function tenantForRequest(req) {
  req.bfPublic = false;
  const url = new URL(req.url || "/", "http://localhost");
  const publicMatch = url.pathname.match(/^\/in\/public\/([^/]+)(\/.*)?$/);
  if (publicMatch) {
    req.bfPublic = true;
    const tenant = Object.values(state.tenants).find((item) => item.slug === decodeURIComponent(publicMatch[1]));
    const path = publicRuntimePath(publicMatch[2] || "/");
    if (!path) return undefined;
    if (tenant) req.url = `${path}${url.search}`;
    return tenant;
  }
  const id = String(req.headers["x-betterframe-tenant"] || "");
  if (id) return state.tenants[id] || Object.values(state.tenants).find((item) => item.slug === id);
  return undefined; // No implicit global/default runtime for unscoped requests.
}

function runtimeHeaders(req, tenant) {
  const headers = { ...req.headers, host: `127.0.0.1:${tenant.port}` };
  delete headers["x-betterframe-tenant"];
  // Platform sessions and kiosk cookies belong to the ingress, not tenant code.
  // In particular, a public flow in tenant B must not see a browser's A session.
  delete headers.cookie;
  delete headers["x-betterframe-runtime-token"];
  delete headers["x-betterframe-dashboard-token"];
  // Angie overwrites the tenant header after authentication. Public URL routing
  // cannot mint this credential, even if a caller supplies forged headers.
  if (!req.bfPublic && req.headers["x-betterframe-tenant"]) {
    headers["x-betterframe-dashboard-token"] = dashboardToken(tenant);
  }
  const path = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  // Public HTTP nodes can echo request headers. Never give them the credential
  // that also authorizes the editor and internal event dispatcher.
  if (/^\/(?:nrdp(?:\/|$)|api\/internal(?:\/|$))/i.test(path)) {
    headers["x-betterframe-runtime-token"] = tenant.adminToken;
  }
  if (authorized(req) || (!req.bfPublic && req.headers["x-betterframe-tenant"])) delete headers.authorization;
  return headers;
}

async function proxy(req, res, tenant) {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  if (/^\/api\/internal(?:\/|$)/i.test(decodeURIComponent(path)) && !authorized(req)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  if (!tenant) { res.writeHead(403); res.end("tenant authentication required"); return; }
  if (!tenant.active || !runtimes.get(tenant.tenant_id)?.child) {
    res.writeHead(503); res.end("tenant runtime unavailable"); return;
  }
  if (await publicDashboardRequest(req, tenant)) { res.writeHead(403); res.end("dashboard authentication required"); return; }
  // Legacy entity links use a Node-RED page ID, not a FlowFuse route.
  // Resolve only against the authenticated tenant's live pages; stale IDs fail closed.
  if (!req.bfPublic && /^\/dash\/[^/]+\/?$/.test(path) && ["GET", "HEAD"].includes(req.method)) {
    const pages = dashboardPages(await runtimeFlows(tenant));
    const page = pages.some((page) => page.path === path.replace(/\/$/, ""))
      ? undefined : pages.find((page) => `/dash/${page.id}` === path.replace(/\/$/, ""));
    if (page && page.path !== path) {
      const query = new URL(req.url, "http://localhost").search;
      res.writeHead(307, { location: page.path + query, "cache-control": "no-store" }); res.end(); return;
    }
    if (!pages.some((page) => page.path === path.replace(/\/$/, "") || ["socket.io", "_setup", "favicon.ico", "apple-touch-icon.png"].some((part) => path.replace(/\/$/, "") === `${page.basePath}/${part}`))) {
      res.writeHead(404); res.end("dashboard not found"); return;
    }
  }
  const finishChange = /^\/nrdp(?:\/|$)/i.test(decodeURIComponent(path)) && !["GET", "HEAD", "OPTIONS"].includes(req.method)
    ? changingFlows(tenant) : () => {};
  const headers = runtimeHeaders(req, tenant);
  const upstream = httpRequest({ hostname: "127.0.0.1", port: tenant.port, method: req.method, path: req.url, headers }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on("close", finishChange);
  upstream.on("error", () => { finishChange(); if (!res.headersSent) res.writeHead(502); res.end("runtime unavailable"); });
  req.pipe(upstream);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const match = url.pathname.match(/^\/_betterframe\/v1\/tenants\/([^/]+)(\/health|\/dashboards)?$/);
    if (match) {
      if (!authorized(req)) { res.writeHead(401); res.end(); return; }
      const tenantId = decodeURIComponent(match[1]);
      if (req.method === "PUT" && !match[2]) {
        const input = await readJson(req);
        if (input.tenant_id !== tenantId || !/^[a-z0-9][a-z0-9_-]*$/.test(input.slug || "")) throw new Error("invalid tenant payload");
        const tenant = await ensureTenant(input);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runtime_id: tenant.tenant_id, status: tenant.active ? "starting" : "stopped" }));
        return;
      }
      if (req.method === "DELETE" && !match[2]) {
        await deleteTenant(tenantId); res.writeHead(204); res.end(); return;
      }
      if (req.method === "GET" && match[2] === "/dashboards") {
        const tenant = state.tenants[tenantId];
        if (!tenant?.active) { res.writeHead(404); res.end(); return; }
        const pages = dashboardPages(await runtimeFlows(tenant));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(pages)); return;
      }
      if (req.method === "GET" && match[2] === "/health") {
        const tenant = state.tenants[tenantId];
        const child = runtimes.get(tenantId)?.child;
        res.writeHead(tenant ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: child && child.exitCode === null ? "running" : "stopped", port: tenant?.port }));
        return;
      }
      res.writeHead(405); res.end(); return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", active: [...runtimes.values()].filter((runtime) => runtime.child?.exitCode === null).length }));
      return;
    }
    if (url.pathname === "/readyz") {
      const result = await readiness();
      res.writeHead(result.status === "ready" ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(result));
      return;
    }
    await proxy(req, res, tenantForRequest(req));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(400);
    res.end("bad request");
  }
}

if (process.env.BF_NODERED_MANAGER_SELF_TEST === "1") {
  if (!validTenantId("2f1c0b2d-9ad7-4e74-8c2c-4bdcb9f365b0")) throw new Error("UUID validation failed");
  if (validTenantId("../../escape")) throw new Error("path traversal accepted");
  if (publicRuntimePath("/nrdp/flows") !== null) throw new Error("public admin path accepted");
  if (publicRuntimePath("/%6erdp/flows") !== null) throw new Error("encoded public admin path accepted");
  for (const path of ["/api/internal/onvif.motion", "/api%2finternal/onvif.motion", "/x/../api/internal/onvif.motion", "/%2561pi/internal/onvif.motion"]) {
    if (publicRuntimePath(path) !== null) throw new Error("public internal event path accepted");
  }
  if (publicRuntimePath("/camera/event") !== "/camera/event") throw new Error("public node path rejected");
  const testId = "2f1c0b2d-9ad7-4e74-8c2c-4bdcb9f365b0";
  state.tenants[testId] = { tenant_id: testId, slug: "test" };
  if (tenantForRequest({ url: "/", headers: { "x-betterframe-tenant": testId } })?.slug !== "test") throw new Error("tenant UUID route failed");
  if (tenantForRequest({ url: "/", headers: { "x-betterframe-tenant": "test" } })?.tenant_id !== testId) throw new Error("tenant slug route failed");
  if (runtimeEnvironment({ userDir: "/tmp/test", uid: 1, port: 1 }).BF_NODERED_MANAGER_SECRET) throw new Error("manager secret leaked to tenant runtime");
  const headerTenant = { port: 19000, adminToken: "test-admin-token" };
  const publicHeaders = runtimeHeaders({ url: "/echo", headers: {
    "x-betterframe-runtime-token": "caller-forged", authorization: `Bearer ${MANAGER_TOKEN}`, cookie: "betterframe_session=private",
  } }, headerTenant);
  if (publicHeaders["x-betterframe-runtime-token"] || publicHeaders.authorization || publicHeaders.cookie) throw new Error("credential exposed to public flow");
  const eventHeaders = runtimeHeaders({ url: "/api/internal/onvif.motion", headers: {} }, headerTenant);
  if (eventHeaders["x-betterframe-runtime-token"] !== headerTenant.adminToken) throw new Error("internal route lacks runtime credential");
  // Exercise the same HTTP probe used by /readyz against a real listener.
  if ((await readiness()).status !== "ready") throw new Error("empty manager is not ready");
  let fixtureStatus = 503;
  let fixtureDelay = 0;
  let exitDuringProbe = false;
  const child = { pid: process.pid, exitCode: null, signalCode: null, killed: false };
  const readinessServer = createServer((req, res) => {
    if (req.url !== "/nrdp/flows" || req.headers["x-betterframe-runtime-token"] !== "readiness-test-token") {
      res.writeHead(403); res.end(); return;
    }
    if (exitDuringProbe) child.exitCode = 1;
    setTimeout(() => { res.writeHead(fixtureStatus); res.end("[]"); }, fixtureDelay);
  });
  await new Promise((resolve, reject) => {
    readinessServer.once("error", reject);
    readinessServer.listen(0, "127.0.0.1", resolve);
  });
  const readyTenant = { tenant_id: testId, active: true, port: readinessServer.address().port, adminToken: "readiness-test-token" };
  state.tenants[testId] = readyTenant;
  async function expectReadiness(expected, description, timeoutMs = 1500) {
    if ((await readiness(timeoutMs)).status !== expected) throw new Error(`readiness failed: ${description}`);
  }
  try {
    await expectReadiness("not_ready", "configured tenant without a child");
    runtimes.set(testId, { child: { ...child, pid: undefined }, stopping: false });
    await expectReadiness("not_ready", "child failed to spawn");
    runtimes.set(testId, { child, stopping: false });
    await expectReadiness("not_ready", "listener still starting");
    fixtureStatus = 200;
    await expectReadiness("ready", "running child and authenticated listener ready");
    state.tenants.second = { tenant_id: "second", active: true };
    await expectReadiness("not_ready", "one ready tenant cannot hide another failed tenant");
    delete state.tenants.second;
    child.exitCode = 1;
    await expectReadiness("not_ready", "exited child with listener still accepting");
    child.exitCode = null;
    runtimes.get(testId).stopping = true;
    await expectReadiness("not_ready", "stopping child");
    runtimes.get(testId).stopping = false;
    fixtureDelay = 100;
    await expectReadiness("not_ready", "unresponsive listener", 25);
    fixtureDelay = 0;
    exitDuringProbe = true;
    await expectReadiness("not_ready", "child exited during HTTP probe");
    readyTenant.active = false;
    await expectReadiness("ready", "disabled tenant does not block readiness");
  } finally {
    readinessServer.closeAllConnections();
    await new Promise((resolve) => readinessServer.close(resolve));
  }
  const { runInNewContext } = await import("node:vm");
  const assert = (await import("node:assert/strict")).default;
  const fixtureFlows = (slug) => [
    { id: "base", type: "ui-base", path: `/${slug}-custom` },
    { id: "page", type: "ui-page", ui: "base", path: "/page1", name: "Page" },
    { id: "container", type: "ui-base", path: "/unused" },
    { id: "dash-base", type: "ui-base", path: "/dash" },
    { id: "dash-page", type: "ui-page", ui: "dash-base", path: "/page1" },
    { id: "broken", type: "ui-page", ui: "missing", path: "/bad" },
  ];
  assert.deepEqual(dashboardPages(fixtureFlows("a")).map((page) => page.path), ["/a-custom/page1", "/dash/page1"]);
  for (const path of ["//evil.test", "/a/../b", "/a/%2e", "/a?b", "/a#b"]) assert.equal(dashboardPath(path), null);
  const servers = [];
  const savedTenants = state.tenants;
  state.tenants = {};
  try {
    for (const [id, slug] of [[testId, "a"], ["8b34e4b5-24a8-43ca-b655-35ac59d798ce", "b"]]) {
      const tenant = { tenant_id: id, slug, active: true, adminToken: secret(), testFlows: fixtureFlows(slug), testReads: 0, testAdminFail: false };
      const module = { exports: {} };
      runInNewContext(settingsSource(tenant), { module });
      const settings = module.exports;
      assert.equal(typeof settings.dashboard.ioMiddleware, "function");
      for (const [token, allowed] of [[undefined, false], ["forged", false], [dashboardToken(tenant), true]]) {
        settings.dashboard.ioMiddleware({ request: { headers: { "x-betterframe-dashboard-token": token } } }, (error) => assert.equal(!error, allowed));
      }
      const fixture = createServer((req, res) => {
        if (req.url === "/nrdp/flows") {
          if (req.headers["x-betterframe-runtime-token"] !== tenant.adminToken) { res.writeHead(403); res.end(); return; }
          if (req.method === "POST") {
            void readJson(req).then((flows) => { tenant.testFlows = flows; res.end("{}"); }); return;
          }
          tenant.testReads++;
          if (tenant.testAdminFail) { res.writeHead(503); res.end(); return; }
          res.setHeader("content-type", "application/json"); res.end(JSON.stringify(tenant.testFlows)); return;
        }
        if (req.url === "/webhook") {
          assert.equal(req.headers.cookie, undefined);
          res.end("public webhook"); return;
        }
        settings.dashboard.middleware(req, res, () => res.end(slug));
      });
      await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
      servers.push(fixture);
      tenant.port = fixture.address().port;
      state.tenants[id] = tenant;
      runtimes.set(id, { child: {} });
    }
    const gateway = createServer(handleRequest);
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    servers.push(gateway);
    const base = `http://127.0.0.1:${gateway.address().port}`;
    const get = (path, headers = {}) => fetch(base + path, { headers, redirect: "manual" });
    assert.equal((await get("/dashboard/page1")).status, 403);
    assert.equal((await get("/dashboard/page1", { cookie: "bf_tenant=a" })).status, 403);
    for (const tenant of Object.values(state.tenants)) {
      const headers = { "x-betterframe-tenant": tenant.tenant_id };
      const response = await get(`/${tenant.slug}-custom/page1`, headers);
      assert.equal(response.status, 200); assert.equal(await response.text(), tenant.slug);
      const alias = await get("/dash/page?theme=dark", headers);
      assert.equal(alias.status, 307); assert.equal(alias.headers.get("location"), `/${tenant.slug}-custom/page1?theme=dark`);
      assert.equal((await get("/dash/deleted", headers)).status, 404);
      assert.equal((await get("/dash/page1/", headers)).status, 200);
      for (const suffix of ["page1", "assets/app.js", "socket.io/?transport=polling"]) {
        const publicResponse = await get(`/in/public/${tenant.slug}/${tenant.slug}-custom/${suffix}`, {
          ...headers, "x-betterframe-dashboard-token": dashboardToken(tenant),
        });
        assert.equal(publicResponse.status, 403);
      }
      for (const path of ["/dashboard/page1", "/dash/page", "/%64ashboard/page1", "/nrdp/flows"]) {
        assert.equal((await get(`/in/public/${tenant.slug}${path}`)).status, 403);
      }
      assert.equal(await (await get(`/in/public/${tenant.slug}/webhook`, { cookie: "betterframe_session=other-tenant" })).text(), "public webhook");
      const catalogPath = `/_betterframe/v1/tenants/${tenant.tenant_id}/dashboards`;
      assert.equal((await get(catalogPath)).status, 401);
      const catalog = await get(catalogPath, { authorization: `Bearer ${MANAGER_TOKEN}` });
      assert.equal(catalog.status, 200);
      assert.equal((await catalog.json())[0].path, `/${tenant.slug}-custom/page1`);
      const reads = tenant.testReads;
      tenant.testAdminFail = true;
      for (let index = 0; index < 5; index++) assert.equal((await get(`/in/public/${tenant.slug}/webhook`)).status, 200);
      assert.equal(tenant.testReads, reads, "warm webhooks must not call the admin API");
      const finish = changingFlows(tenant);
      assert.equal((await get(`/in/public/${tenant.slug}/webhook`)).status, 403, "deploying roots fail closed");
      finish();
      assert.equal((await get(`/in/public/${tenant.slug}/webhook`)).status, 403, "failed discovery cannot expose a new root");
      tenant.testAdminFail = false;
      const deployed = await fetch(base + "/nrdp/flows", { method: "POST", headers,
        body: JSON.stringify([...tenant.testFlows, { id: "new-root", type: "ui-base", path: "/new-root" }]) });
      assert.equal(deployed.status, 200); await deployed.text();
      const beforeRefresh = tenant.testReads;
      assert.equal((await get(`/in/public/${tenant.slug}/new-root/socket.io/?transport=polling`)).status, 403);
      await Promise.all(Array.from({ length: 10 }, () => get(`/in/public/${tenant.slug}/webhook`).then((r) => assert.equal(r.status, 200))));
      assert.equal(tenant.testReads, beforeRefresh + 1, "deployment refreshes roots once");
    }
  } finally {
    state.tenants = savedTenants;
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  console.log("Node-RED manager self-test passed");
  process.exit(0);
}

await loadState();
for (const tenant of Object.values(state.tenants)) if (tenant.active) void startRuntime(tenant);

const server = createServer(handleRequest);

server.on("upgrade", async (req, socket, head) => {
  let tenant;
  try {
    tenant = tenantForRequest(req);
    if (tenant && await publicDashboardRequest(req, tenant)) { socket.destroy(); return; }
    if (/^\/api\/internal(?:\/|$)/i.test(decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname))) {
      socket.destroy(); return;
    }
  } catch { socket.destroy(); return; }
  if (!tenant?.active) { socket.destroy(); return; }
  const finishChange = /^\/nrdp(?:\/|$)/i.test(decodeURIComponent(path)) && !["GET", "HEAD", "OPTIONS"].includes(req.method)
    ? changingFlows(tenant) : () => {};
  const headers = runtimeHeaders(req, tenant);
  const upstream = httpRequest({ hostname: "127.0.0.1", port: tenant.port, method: "GET", path: req.url, headers });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});

server.listen(PORT, "0.0.0.0", () => console.log(`BetterFrame Node-RED manager listening on ${PORT}`));
