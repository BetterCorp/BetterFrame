/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { List } from "../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section class="frame-ui">
      {List(data, ctx)}
      <details class="mt-4 frame-create">
        <summary>Add content</summary>
        <BPRoute
          ctx={ctx}
          path="/entities"
          method="POST"
          as="form"
          target="#frame-action-result"
          swap="innerHTML"
        >
          <bp-ok>
            <p class="frame-section-note">
              Choose a content type and complete its matching fields.
            </p>
            <label class="form-label d-block">
              Name
              <input class="form-control" name="name" type="text" />
            </label>
            <label class="form-label d-block">
              Content type
              <select class="form-select" name="type">
                <option value="camera">Camera</option>
                <option value="html">HTML</option>
                <option value="web">Web page</option>
                {data.canUseNodeRed ? <option value="dashboard">Node-RED dashboard</option> : null}
              </select>
            </label>
            <label class="form-label d-block">
              Description
              <input class="form-control" name="description" type="text" />
            </label>
            <label class="form-label d-block">
              Camera
              <select class="form-select" name="camera_id">
                <option value="">Choose a camera</option>
                {data.cameras.map((camera) => (
                  <option value={camera.id}>{camera.name}</option>
                ))}
              </select>
            </label>
            <label class="form-label d-block">
              HTML content
              <textarea class="form-control" name="html_content" />
            </label>
            <label class="form-label d-block">
              Web URL
              <input class="form-control" name="web_url" type="url" />
            </label>
            {data.canUseNodeRed ? (
              <label class="form-label d-block">
                Node-RED dashboard ID
                <input class="form-control" name="dashboard_id" type="text" />
              </label>
            ) : null}
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
