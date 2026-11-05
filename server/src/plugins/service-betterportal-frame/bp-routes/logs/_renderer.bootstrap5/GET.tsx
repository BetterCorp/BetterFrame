/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { Navigation, PageHeading, ResourceTable } from "../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section class="frame-ui">
      <Navigation ctx={ctx} />
      <PageHeading title={data.title} count={data.items.length} />
      <BPRoute ctx={ctx} path="/logs" method="GET" as="form" class="frame-filter row g-3 mb-4">
        <bp-ok>
          <label class="col-12 col-md">
            Search
            <input class="form-control" name="q" value={String(ctx.request.query.q ?? "")} />
          </label>
          <label class="col-12 col-md">
            Kiosk ID
            <input
              class="form-control"
              name="kiosk"
              value={String(ctx.request.query.kiosk ?? "")}
            />
          </label>
          <label class="col-12 col-md">
            Level
            <select class="form-select" name="level">
              <option value="">All levels</option>
              {["debug", "info", "warn", "error"].map((level) => (
                <option value={level} selected={level === ctx.request.query.level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" class="btn btn-primary col-auto align-self-end">
            Filter
          </button>
        </bp-ok>
      </BPRoute>
      <ResourceTable data={data} ctx={ctx} />
      {data.nextCursor ? (
        <BPRoute
          ctx={ctx}
          path="/logs"
          query={{
            ...ctx.request.query,
            before: data.nextCursor,
            until: data.until,
          }}
        >
          <bp-ok class="btn btn-outline-secondary mt-3">Older logs</bp-ok>
          <bp-error>Next page unavailable.</bp-error>
        </BPRoute>
      ) : null}
    </section>
  );
}
