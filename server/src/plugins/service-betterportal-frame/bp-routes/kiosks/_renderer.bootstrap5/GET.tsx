/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ListSchema } from "../../../models.js";
import { List } from "../../../ui.js";
export function render(data: Infer<typeof ListSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section>
      {List(data, ctx)}
      <details class="mt-4">
        <summary>Pair kiosk</summary>
        <BPRoute
          ctx={ctx}
          path="/kiosks/pair"
          method="POST"
          as="form"
          target="#frame-action-result"
          swap="innerHTML"
        >
          <bp-ok>
            <label class="form-label">
              Pairing code
              <input class="form-control" name="code" required maxlength="8" />
            </label>
            <label class="form-label">
              Name
              <input class="form-control" name="name" />
            </label>
            <button class="btn btn-primary" type="submit">
              Pair
            </button>
          </bp-ok>
          <bp-noperm>You do not have pairing permission.</bp-noperm>
        </BPRoute>
        <div id="frame-action-result" role="status" />
      </details>
    </section>
  );
}
