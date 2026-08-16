import { randomBytes } from "node:crypto";

/**
 * Return an HTML response from JSX-rendered markup.
 *
 * h3 v2's html() is a tagged template literal only — can't pass
 * a string/object directly. This helper wraps JSX output in a
 * proper Response with text/html content type.
 */
/**
 * Baseline security headers. CSP keeps 'unsafe-inline' for scripts because
 * jsx-htmx's js() helper emits inline <script> blocks and htmx uses inline
 * event handler attributes; tightening this needs per-render nonces.
 */
const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'self'; " +
    "img-src 'self' data: blob:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "frame-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
} as const;

export function htmlPage(markup: unknown): Response {
  return new Response(String(markup), { headers: SECURITY_HEADERS });
}

/** Same as htmlPage — separate name for htmx fragment swaps to read clearly. */
export function htmlFragment(markup: unknown): Response {
  return new Response(String(markup), { headers: SECURITY_HEADERS });
}

/** Debug pages carry terminal output, so their inline script is nonce-only. */
export function debugHtmlPage(markup: unknown): Response {
  const nonce = randomBytes(18).toString("base64url");
  const html = String(markup).replaceAll("<script>", `<script nonce="${nonce}">`);
  const headers = new Headers(SECURITY_HEADERS);
  headers.set(
    "content-security-policy",
    SECURITY_HEADERS["content-security-policy"].replace(
      "script-src 'self' 'unsafe-inline'",
      `script-src 'self' 'nonce-${nonce}'`,
    ),
  );
  return new Response(html, { headers });
}

/**
 * Build a redirect Response with optional Set-Cookie header.
 * Avoids h3's setCookie which doesn't play well with returning
 * a raw Response object.
 */
export function redirectWithCookie(
  location: string,
  cookie?: CookieSpec | CookieSpec[],
  status = 302,
): Response {
  const headers = new Headers({ location });
  if (cookie) {
    for (const item of Array.isArray(cookie) ? cookie : [cookie]) {
      headers.append("set-cookie", serializeCookie(item));
    }
  }
  return new Response(null, { status, headers });
}

/** Build a redirect that clears a cookie. */
export function redirectClearCookie(location: string, cookieName: string | string[]): Response {
  const headers = new Headers({ location });
  for (const name of Array.isArray(cookieName) ? cookieName : [cookieName]) {
    headers.append("set-cookie", `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }
  return new Response(null, {
    status: 302,
    headers,
  });
}

interface CookieSpec {
  name: string;
  value: string;
  maxAge: number;
  httpOnly?: boolean;
  secure?: boolean;
}

function serializeCookie(cookie: CookieSpec): string {
  return [
    `${cookie.name}=${cookie.value}`,
    "Path=/",
    cookie.httpOnly === false ? "" : "HttpOnly",
    "SameSite=Strict",
    cookie.secure ? "Secure" : "",
    `Max-Age=${cookie.maxAge}`,
  ].filter(Boolean).join("; ");
}
