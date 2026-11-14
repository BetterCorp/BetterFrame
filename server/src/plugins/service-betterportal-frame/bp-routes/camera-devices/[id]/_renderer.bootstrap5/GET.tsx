/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { Navigation } from "../../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section class="frame-ui">
      <Navigation ctx={ctx} />
      <h1 class="h3">{data.name}</h1>
      <BPRoute
        ctx={ctx}
        path="/camera-devices/:id"
        params={{ id: data.id }}
        method="PUT"
        as="form"
        target="#frame-action-result"
        swap="innerHTML"
      >
        <bp-ok>
          <label class="form-label">
            Name
            <input class="form-control" name="name" value={data.name} />
          </label>
          <label class="form-label d-block">
            Host
            <input class="form-control" name="host" type="text" value={data.host} />
          </label>
          <label class="form-label d-block">
            Port
            <input class="form-control" name="port" type="number" value={String(data.port)} />
          </label>
          <button type="submit" class="btn btn-primary ms-2">
            Save
          </button>
        </bp-ok>
        <bp-noperm>Read-only access.</bp-noperm>
        <bp-error>Editing unavailable.</bp-error>
      </BPRoute>
      <BPRoute
        ctx={ctx}
        path="/camera-devices/:id"
        params={{ id: data.id }}
        method="DELETE"
        as="button"
        target="#frame-action-result"
        swap="innerHTML"
        class="btn btn-outline-danger mt-3"
        hx-confirm="Delete this resource?"
      >
        <bp-ok>Delete</bp-ok>
        <bp-noperm as="none"></bp-noperm>
        <bp-error as="none"></bp-error>
      </BPRoute>
      <div id="frame-action-result" role="status" />
    </section>
  );
}
