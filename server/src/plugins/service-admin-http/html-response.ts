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

/**
 * Build a redirect Response with optional Set-Cookie header.
 * Avoids h3's setCookie which doesn't play well with returning
 * a raw Response object.
 */
export function redirectWithCookie(
  location: string,
  cookie?: { name: string; value: string; maxAge: number },
  status = 302,
): Response {
  const headers = new Headers({ location });
  if (cookie) {
    headers.set(
      "set-cookie",
      `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookie.maxAge}`,
    );
  }
  return new Response(null, { status, headers });
}

/** Build a redirect that clears a cookie. */
export function redirectClearCookie(location: string, cookieName: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}
