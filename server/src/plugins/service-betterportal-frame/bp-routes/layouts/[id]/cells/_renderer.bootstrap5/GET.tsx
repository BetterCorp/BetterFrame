/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { Navigation } from "../../../../../ui.js";
type Data = Infer<typeof ResponseSchema>;
function Fields({
  cell,
  entities,
}: {
  cell: Data["cells"][number];
  entities: Data["entities"];
}): HtmlRenderable {
  return (
    <div class="row g-2">
      <label class="col-sm">
        Row
        <input class="form-control" type="number" min="0" max="63" name="row" value={String(cell.row)} />
      </label>
      <label class="col-sm">
        Column
        <input class="form-control" type="number" min="0" max="63" name="col" value={String(cell.col)} />
      </label>
      <label class="col-sm">
        Rows
        <input
          class="form-control"
          type="number"
          min="1"
          max="32"
          name="row_span"
          value={String(cell.row_span)}
        />
      </label>
      <label class="col-sm">
        Columns
        <input
          class="form-control"
          type="number"
          min="1"
          max="32"
          name="col_span"
          value={String(cell.col_span)}
        />
      </label>
      <label class="col-sm">
        Content
        <select class="form-select" name="entity_id">
          <option value="">Empty</option>
          {entities.map((e) => (
            <option value={e.id} selected={e.id === cell.entity_id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <label class="col-sm">
        Fit
        <select class="form-select" name="fit">
          {["cover", "contain", "fill"].map((value) => (
            <option value={value} selected={value === cell.fit}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label class="col-sm">
        Stream
        <select class="form-select" name="stream_selector">
          {["auto", "main", "sub"].map((value) => (
            <option value={value} selected={value === cell.stream_selector}>
              {value}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function render(data: Data, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section>
      <Navigation ctx={ctx} />
      <h1 class="h3">{data.name}: cells</h1>
      {data.cells.map((cell) => (
        <article class="card mb-3">
          <div class="card-body">
            <BPRoute
              ctx={ctx}
              path="/layouts/:id/cells/:cellId"
              params={{ id: data.id, cellId: cell.id }}
              method="PUT"
              as="form"
              target="#frame-action-result"
              swap="innerHTML"
            >
              <bp-ok>
                <Fields cell={cell} entities={data.entities} />
                <button class="btn btn-primary mt-2" type="submit">
                  Save cell
                </button>
              </bp-ok>
              <bp-noperm>Read-only cell.</bp-noperm>
            </BPRoute>
            <BPRoute
              ctx={ctx}
              path="/layouts/:id/cells/:cellId"
              params={{ id: data.id, cellId: cell.id }}
              method="DELETE"
              as="button"
              target="#frame-action-result"
              class="btn btn-outline-danger mt-2"
              hx-confirm="Delete this cell?"
            >
              <bp-ok>Delete cell</bp-ok>
              <bp-noperm as="none"></bp-noperm>
            </BPRoute>
          </div>
        </article>
      ))}
      <h2 class="h5">Add cell</h2>
      <BPRoute
        ctx={ctx}
        path="/layouts/:id/cells"
        params={{ id: data.id }}
        method="POST"
        as="form"
        target="#frame-action-result"
        swap="innerHTML"
      >
        <bp-ok>
          <Fields
            cell={{
              id: "",
              row: 0,
              col: 0,
              row_span: 1,
              col_span: 1,
              entity_id: "",
              fit: "cover",
              stream_selector: "auto",
            }}
            entities={data.entities}
          />
          <button class="btn btn-primary mt-2" type="submit">
            Add cell
          </button>
        </bp-ok>
        <bp-noperm as="none"></bp-noperm>
      </BPRoute>
      <div id="frame-action-result" role="status" />
    </section>
  );
}
