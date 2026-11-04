/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { Navigation } from "../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  const windows = data.schedule.windows.length
    ? data.schedule.windows
    : [{ day: 0, start: "00:00", end: "06:00" }];
  return (
    <section>
      <Navigation ctx={ctx} />
      <h1 class="h3">Settings</h1>
      <h2 class="h5">Update schedule</h2>
      <BPRoute
        ctx={ctx}
        path="/settings/update-schedule"
        method="POST"
        as="form"
        target="#frame-action-result"
      >
        <bp-ok>
          <select class="form-select mb-2" name="schedule.mode">
            <option value="always" selected={data.schedule.mode === "always"}>
              Updates allowed any time
            </option>
            <option value="windows" selected={data.schedule.mode === "windows"}>
              Only during these windows
            </option>
          </select>
          {windows.map((window, index) => (
            <div class="row g-2 mb-2">
              <label class="col">
                Day (0 Sunday–6 Saturday)
                <input
                  class="form-control"
                  type="number"
                  min="0"
                  max="6"
                  name={`schedule.windows[${index}].day`}
                  value={String(window.day)}
                />
              </label>
              <label class="col">
                From
                <input
                  class="form-control"
                  type="time"
                  name={`schedule.windows[${index}].start`}
                  value={window.start}
                />
              </label>
              <label class="col">
                Until
                <input
                  class="form-control"
                  type="time"
                  name={`schedule.windows[${index}].end`}
                  value={window.end}
                />
              </label>
            </div>
          ))}
          <button class="btn btn-primary" type="submit">
            Save schedule
          </button>
        </bp-ok>
        <bp-noperm>Read-only settings.</bp-noperm>
      </BPRoute>
      <h2 class="h5 mt-4">New display defaults</h2>
      <BPRoute
        ctx={ctx}
        path="/settings/display-defaults"
        method="POST"
        as="form"
        target="#frame-action-result"
      >
        <bp-ok>
          {data.layouts.map((l) => (
            <label class="d-block">
              <input type="checkbox" name="layoutIds" value={l.id} checked={data.layoutIds.includes(l.id)} />{" "}
              {l.name}
            </label>
          ))}
          <label class="form-label">
            Default layout
            <select class="form-select" name="defaultLayoutId">
              <option value="">None</option>
              {data.layouts.map((l) => (
                <option value={l.id} selected={l.id === data.defaultLayoutId}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <button class="btn btn-primary ms-2" type="submit">
            Save defaults
          </button>
        </bp-ok>
        <bp-noperm>Read-only defaults.</bp-noperm>
      </BPRoute>
      <div id="frame-action-result" role="status" />
    </section>
  );
}
