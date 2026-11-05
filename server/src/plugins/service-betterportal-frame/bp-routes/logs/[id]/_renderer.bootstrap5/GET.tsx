/* @jsxImportSource @betterportal/framework */
import type { HtmlRenderable, ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { Navigation } from "../../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section class="frame-ui">
      <Navigation ctx={ctx} />
      <h1 class="h3">Diagnostic log</h1>
      <p>
        {data.kioskId} · {data.level} · <time datetime={data.loggedAt}>{data.loggedAt}</time>
      </p>
      <pre class="border rounded p-3" style="white-space:pre-wrap;overflow-wrap:anywhere">
        {data.message}
      </pre>
    </section>
  );
}
