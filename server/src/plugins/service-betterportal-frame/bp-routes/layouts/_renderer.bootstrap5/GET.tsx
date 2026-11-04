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
        <summary>Add layouts</summary>
        <BPRoute
          ctx={ctx}
          path="/layouts"
          method="POST"
          as="form"
          target="#frame-action-result"
          swap="innerHTML"
        >
          <bp-ok>
            <label class="form-label d-block">
              Name
              <input class="form-control" name="name" type="text" />
            </label>
            <label class="form-label d-block">
              Description
              <input class="form-control" name="description" type="text" />
            </label>
            <label class="form-label d-block">
              Priority: hot, normal or cold
              <select class="form-select" name="priority">
                <option value="normal">normal</option>
                <option value="hot">hot</option>
                <option value="cold">cold</option>
              </select>
            </label>
            <label class="form-label d-block">
              Cooling timeout (seconds)
              <input class="form-control" name="cooling_timeout_seconds" type="number" value="0" />
            </label>
            <label class="form-label d-block">
              Idle timeout (seconds)
              <input class="form-control" name="idle_timeout_seconds" type="number" value="0" />
            </label>
            <button class="btn btn-primary" type="submit">
              Create
            </button>
          </bp-ok>
          <bp-noperm>You do not have permission to create this resource.</bp-noperm>
          <bp-error>Creation unavailable.</bp-error>
        </BPRoute>
        <div id="frame-action-result" role="status" />
      </details>
    </section>
  );
}
