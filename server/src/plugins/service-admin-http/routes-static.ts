/**
 * Static file serving for /static/* paths.
 *
 * In production the Angie proxy serves these directly;
 * this handler is for dev mode only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { type H3, getRouterParam, createError } from "h3";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function registerStaticRoutes(app: H3, pluginCwd: string): void {
  const STATIC_DIR = resolve(pluginCwd, "../../web-static");

  app.get("/static/**:path", (event) => {
    const reqPath = getRouterParam(event, "path");
    if (!reqPath) throw createError({ statusCode: 404 });

    const resolved = resolve(STATIC_DIR, reqPath);
    if (!resolved.startsWith(STATIC_DIR)) {
      throw createError({ statusCode: 403 });
    }

    if (!existsSync(resolved)) {
      throw createError({ statusCode: 404 });
    }

    const ext = extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const body = readFileSync(resolved);

    return new Response(body, {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=86400",
      },
    });
  });
}
