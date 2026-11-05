/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ListSchema } from "../../../models.js";
import { List } from "../../../ui.js";
export function render(data: Infer<typeof ListSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section class="frame-ui">
      {List(data, ctx)}
      <details class="mt-4 frame-create">
        <summary>Add camera</summary>
        <BPRoute
          ctx={ctx}
          path="/cameras"
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
              Connection type
              <select class="form-select" name="type">
                <option value="rtsp">RTSP stream</option>
                <option value="onvif">ONVIF camera</option>
              </select>
            </label>
            <label class="form-label d-block">
              RTSP URL
              <input class="form-control" name="rtsp_url" type="password" />
            </label>
            <label class="form-label d-block">
              ONVIF host
              <input class="form-control" name="onvif_host" type="text" />
            </label>
            <label class="form-label d-block">
              ONVIF port
              <input class="form-control" name="onvif_port" type="number" value="80" />
            </label>
            <label class="form-label d-block">
              ONVIF username
              <input class="form-control" name="onvif_username" type="text" />
            </label>
            <label class="form-label d-block">
              ONVIF password
              <input class="form-control" name="onvif_password" type="password" />
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
