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
