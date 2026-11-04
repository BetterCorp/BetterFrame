/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { List } from "../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section>
      {List(data, ctx)}
      {data.items.map((item) => (
        <div class="d-flex align-items-center gap-2 mb-2">
          <span>{item.name}</span>
          <BPRoute
            ctx={ctx}
            path="/cloud-accounts/:id/sync"
            params={{ id: item.id }}
            method="POST"
            as="button"
            target="#frame-action-result"
          >
            <bp-ok>Sync</bp-ok>
            <bp-noperm as="none"></bp-noperm>
          </BPRoute>
          <BPRoute
            ctx={ctx}
            path="/cloud-accounts/:id/delete"
            params={{ id: item.id }}
            method="DELETE"
            as="button"
            target="#frame-action-result"
            hx-confirm="Delete account and its cloud cameras?"
          >
            <bp-ok>Delete</bp-ok>
            <bp-noperm as="none"></bp-noperm>
          </BPRoute>
        </div>
      ))}
      <h2 class="h5 mt-4">Add account</h2>
      {data.providers.map((provider) => (
        <details class="mb-3">
          <summary>{provider.vendor}</summary>
          <BPRoute
            ctx={ctx}
            path="/cloud-accounts"
            method="POST"
            as="form"
            target="#frame-action-result"
            swap="innerHTML"
          >
            <bp-ok>
              <input type="hidden" name="vendor" value={provider.vendor} />
              <label class="form-label">
                Name
                <input class="form-control" name="name" required />
              </label>
              {provider.fields.map((field) => (
                <label class="form-label d-block">
                  {field.label}
                  <input
                    class="form-control"
                    name={`credentials.${field.name}`}
                    type={field.secret ? "password" : "text"}
                    required={field.required}
                    autocomplete="off"
                  />
                </label>
              ))}
              <button class="btn btn-primary" type="submit">
                Verify and add
              </button>
            </bp-ok>
            <bp-noperm as="none"></bp-noperm>
          </BPRoute>
        </details>
      ))}
      <div id="frame-action-result" role="status" />
    </section>
  );
}
