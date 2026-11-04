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
        <summary>Add entities</summary>
        <BPRoute
          ctx={ctx}
          path="/entities"
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
              Type: camera, html, web or dashboard
              <select class="form-select" name="type">
                <option value="camera">camera</option>
                <option value="html">html</option>
                <option value="web">web</option>
                <option value="dashboard">dashboard</option>
              </select>
            </label>
            <label class="form-label d-block">
              Description
              <input class="form-control" name="description" type="text" />
            </label>
            <label class="form-label d-block">
              Camera ID
              <input class="form-control" name="camera_id" type="text" />
            </label>
            <label class="form-label d-block">
              HTML content
              <textarea class="form-control" name="html_content" />
            </label>
            <label class="form-label d-block">
              Web URL
              <input class="form-control" name="web_url" type="url" />
            </label>
            <label class="form-label d-block">
              Dashboard ID
              <input class="form-control" name="dashboard_id" type="text" />
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
