/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { Navigation } from "../../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section>
      <Navigation ctx={ctx} />
      <h1 class="h3">{data.name}</h1>
      <BPRoute
        ctx={ctx}
        path="/layouts/:id"
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
            Description
            <input class="form-control" name="description" type="text" value={data.description} />
          </label>
          <label class="form-label d-block">
            Priority
            <select class="form-select" name="priority">
              <option value="hot" selected={data.priority === "hot"}>
                hot
              </option>
              <option value="normal" selected={data.priority === "normal"}>
                normal
              </option>
              <option value="cold" selected={data.priority === "cold"}>
                cold
              </option>
            </select>
          </label>
          <label class="form-label d-block">
            Cooling timeout (seconds)
            <input
              class="form-control"
              name="cooling_timeout_seconds"
              type="number"
              value={String(data.cooling_timeout_seconds)}
            />
          </label>
          <label class="form-label d-block">
            Idle timeout (seconds)
            <input
              class="form-control"
              name="idle_timeout_seconds"
              type="number"
              value={String(data.idle_timeout_seconds)}
            />
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
        path="/layouts/:id"
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
      <BPRoute
        ctx={ctx}
        path="/layouts/:id/cells"
        params={{ id: data.id }}
        class="btn btn-outline-primary ms-2"
      >
        <bp-ok>Edit grid</bp-ok>
        <bp-error>Grid unavailable.</bp-error>
      </BPRoute>
      <div id="frame-action-result" role="status" />
    </section>
  );
}
