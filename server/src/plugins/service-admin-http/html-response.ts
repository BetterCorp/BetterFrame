/**
 * Return an HTML response from JSX-rendered markup.
 *
 * h3 v2's html() is a tagged template literal only — can't pass
 * a string/object directly. This helper wraps JSX output in a
 * proper Response with text/html content type.
 */
export function htmlPage(markup: unknown): Response {
  return new Response(String(markup), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Same as htmlPage — separate name for htmx fragment swaps to read clearly. */
export function htmlFragment(markup: unknown): Response {
  return new Response(String(markup), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
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
