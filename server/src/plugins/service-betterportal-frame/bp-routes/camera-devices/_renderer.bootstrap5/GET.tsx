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
        <summary>Add camera devices</summary>
        <BPRoute
          ctx={ctx}
          path="/camera-devices"
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
              Host
              <input class="form-control" name="host" type="text" />
            </label>
            <label class="form-label d-block">
              Port
              <input class="form-control" name="port" type="number" value="80" />
            </label>
            <label class="form-label d-block">
              Username
              <input class="form-control" name="username" type="text" />
            </label>
            <label class="form-label d-block">
              Password
              <input class="form-control" name="password" type="password" />
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
