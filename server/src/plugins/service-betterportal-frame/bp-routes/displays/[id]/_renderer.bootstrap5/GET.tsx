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
        path="/displays/:id"
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
            Enabled
            <select class="form-select" name="is_enabled">
              <option value="true" selected={data.is_enabled}>
                Enabled
              </option>
              <option value="false" selected={!data.is_enabled}>
                Disabled
              </option>
            </select>
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
          <label class="form-label d-block">
            Sleep timeout (seconds)
            <input
              class="form-control"
              name="sleep_timeout_seconds"
              type="number"
              value={String(data.sleep_timeout_seconds)}
            />
          </label>
          <button type="submit" class="btn btn-primary ms-2">
            Save
          </button>
        </bp-ok>
        <bp-noperm>Read-only access.</bp-noperm>
        <bp-error>Editing unavailable.</bp-error>
      </BPRoute>
      <div class="frame-power">
        <h2 class="h6">Power controls</h2>
        <BPRoute
          ctx={ctx}
          path="/displays/:id/power/wake"
          params={{ id: data.id }}
          method="POST"
          as="button"
          target="#frame-action-result"
          swap="innerHTML"
          class="btn btn-outline-secondary me-2"
        >
          <bp-ok>Wake</bp-ok>
          <bp-noperm as="none"></bp-noperm>
          <bp-error as="none"></bp-error>
        </BPRoute>
        <BPRoute
          ctx={ctx}
          path="/displays/:id/power/standby"
          params={{ id: data.id }}
          method="POST"
          as="button"
          target="#frame-action-result"
          swap="innerHTML"
          class="btn btn-outline-secondary me-2"
        >
          <bp-ok>Standby</bp-ok>
          <bp-noperm as="none"></bp-noperm>
          <bp-error as="none"></bp-error>
        </BPRoute>
      </div>
      <h2 class="h5 mt-4">Assigned layouts</h2>
      {data.layouts.map((layout) => (
        <div class="frame-assignment d-flex align-items-center gap-2 mb-2">
          <span>{layout.name}</span>
          <BPRoute
            ctx={ctx}
            path="/displays/:id/layout"
            params={{ id: data.id }}
            method="POST"
            as="form"
            class="frame-inline mb-0"
            target="#frame-action-result"
            swap="innerHTML"
          >
            <bp-ok>
              <input type="hidden" name="layout_id" value={layout.id} />
              <button type="submit" class="btn btn-outline-primary">
                Show layout
              </button>
            </bp-ok>
            <bp-noperm as="none"></bp-noperm>
          </BPRoute>
          <BPRoute
            ctx={ctx}
            path="/displays/:id/layouts"
            params={{ id: data.id }}
            method="DELETE"
            as="form"
            class="frame-inline mb-0"
            target="#frame-action-result"
            swap="innerHTML"
          >
            <bp-ok>
              <input type="hidden" name="layout_id" value={layout.id} />
              <button type="submit" class="btn btn-outline-danger">
                Detach
              </button>
            </bp-ok>
            <bp-noperm as="none"></bp-noperm>
          </BPRoute>
        </div>
      ))}
      <BPRoute
        ctx={ctx}
        path="/displays/:id/layouts"
        params={{ id: data.id }}
        method="POST"
        as="form"
        target="#frame-action-result"
        swap="innerHTML"
      >
        <bp-ok>
          <label>
            Attach layout
            <select class="form-select" name="layout_id">
              {data.availableLayouts.map((layout) => (
                <option value={layout.id}>{layout.name}</option>
              ))}
            </select>
          </label>
          <button class="btn btn-outline-primary mt-2" type="submit">
            Attach
          </button>
        </bp-ok>
        <bp-noperm as="none"></bp-noperm>
      </BPRoute>
      <div id="frame-action-result" role="status" />
    </section>
  );
}
