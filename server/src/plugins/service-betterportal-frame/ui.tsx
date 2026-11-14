/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import { ListSchema, ActionSchema } from "./models.js";
const groups = [
  {
    name: "Fleet",
    paths: ["kiosks", "displays", "cameras", "camera-devices", "iobox"],
  },
  { name: "Content", paths: ["layouts", "entities", "labels"] },
  { name: "Activity", paths: ["logs", "events", "audit"] },
  {
    name: "Administration",
    paths: ["cloud-accounts", "ablesign", "firmware", "os-updates", "settings"],
  },
];
const names: Record<string, string> = {
  overview: "Overview",
  "camera-devices": "Camera devices",
  iobox: "IO boxes",
  "cloud-accounts": "Cloud accounts",
  ablesign: "AbleSign",
  "os-updates": "OS updates",
};
const label = (path: string) => names[path] ?? path.charAt(0).toUpperCase() + path.slice(1);
export function FrameStyles(): HtmlRenderable {
  return (
    <style>{`
    .frame-ui {--frame-line:var(--bs-border-color,#dee2e6); color:var(--bs-body-color); max-width:1280px; margin-inline:auto; padding:8px 4px 32px;}
    .frame-ui .frame-navigation {border-bottom:1px solid var(--frame-line); padding-bottom:16px; margin-bottom:28px;}
    .frame-ui .frame-navigation summary {font-weight:500; font-size:.875rem; padding:6px 10px; border-radius:6px; cursor:pointer;}
    .frame-ui .frame-navigation details[open] {flex:1 0 100%; order:2; border:1px solid var(--frame-line); border-radius:8px; padding:8px;}
    .frame-ui .frame-navigation a {text-decoration:none; padding:6px 10px; border-radius:6px; font-size:.875rem;}
    .frame-ui .frame-navigation a:hover {background:var(--bs-tertiary-bg);}
    .frame-ui .frame-ui {padding:0; margin:0;}
    .frame-ui h1 {font-weight:600; letter-spacing:-.025em; margin-bottom:24px; overflow-wrap:anywhere;}
    .frame-ui h2 {margin-bottom:16px; font-weight:600;}
    .frame-ui .frame-heading {display:flex; align-items:baseline; gap:12px; margin-bottom:20px; flex-wrap:wrap;}
    .frame-ui .frame-heading h1 {margin:0;}
    .frame-ui .frame-table {border:1px solid var(--frame-line); border-radius:10px; overflow:auto;}
    .frame-ui .frame-table table {margin:0; min-width:540px;}
    .frame-ui .frame-table th {background:var(--bs-tertiary-bg); font-size:.75rem; font-weight:600; color:var(--bs-secondary-color); padding:12px 20px; white-space:nowrap;}
    .frame-ui .frame-table td {padding:16px 20px; vertical-align:middle; overflow-wrap:anywhere; max-width:520px;}
    .frame-ui .frame-table td:first-child a {font-weight:500; text-decoration:none;}
    .frame-ui .frame-table tr:last-child td {border-bottom:0;}
    .frame-ui .frame-status {font-size:.8125rem; white-space:nowrap;}
    .frame-ui .frame-summary {color:var(--bs-secondary-color); font-size:.875rem;}
    .frame-ui .frame-empty {text-align:center; padding:40px 24px;}
    .frame-ui details:not(.frame-navigation details) {border:1px solid var(--frame-line); border-radius:10px; padding:0; margin-top:24px;}
    .frame-ui details:not(.frame-navigation details) summary {padding:16px 20px; font-weight:600; cursor:pointer;}
    .frame-ui details:not(.frame-navigation details)[open] summary {border-bottom:1px solid var(--frame-line); margin-bottom:20px;}
    .frame-ui details:not(.frame-navigation details) bp-route form {margin:0 20px 20px; width:auto;}
    .frame-ui form:not(.frame-inline) {max-width:760px; margin-bottom:24px;}
    .frame-ui form:not(.frame-inline) .form-label {display:block; font-size:.875rem; font-weight:500; margin-bottom:18px;}
    .frame-ui form:not(.frame-inline) .form-label .form-control,.frame-ui form:not(.frame-inline) .form-label .form-select {margin-top:6px;}
    .frame-ui textarea {min-height:120px;}
    .frame-ui form .btn.ms-2 {margin-left:0!important;}
    .frame-ui .frame-panel {border:1px solid var(--frame-line); border-radius:10px; padding:24px; margin-bottom:24px;}
    .frame-ui .frame-panel form:last-child {margin-bottom:0;}
    .frame-ui .frame-section-note {font-size:.875rem; color:var(--bs-secondary-color); max-width:64ch; margin-bottom:20px;}
    .frame-ui .frame-power {border-top:1px solid var(--frame-line); padding-top:20px; margin-top:24px; margin-bottom:24px;}
    .frame-ui .frame-assignment {border-bottom:1px solid var(--frame-line); padding:12px 0; flex-wrap:wrap;}
    .frame-ui .frame-assignment span {flex:1 1 180px; font-weight:500;}
    .frame-ui .frame-filter {max-width:none!important; background:var(--bs-tertiary-bg); padding:16px; border-radius:8px;}
    .frame-ui .frame-filter label {font-size:.8125rem; font-weight:500; min-width:140px;}
    .frame-ui .frame-cell-fields {display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:16px;}
    .frame-ui .frame-cell-fields label {font-size:.875rem;}
    .frame-ui .frame-cell-fields label:nth-child(5) {grid-column:span 2;}
    .frame-ui #frame-action-result:not(:empty) {margin-top:24px;}
    .frame-ui pre {white-space:pre-wrap; overflow-wrap:anywhere; padding:20px; background:var(--bs-tertiary-bg); border:1px solid var(--frame-line); border-radius:8px;}
    @media(max-width:575px) {.frame-ui .frame-panel{padding:16px;} .frame-ui .frame-cell-fields{grid-template-columns:repeat(2,minmax(0,1fr));} .frame-ui .frame-filter{margin-inline:0;} .frame-ui .frame-navigation{gap:4px!important;} .frame-ui .frame-heading{margin-bottom:16px;}}
  `}</style>
  );
}
export function Navigation({ ctx }: { ctx: ViewRenderContext }): HtmlRenderable {
 const current=ctx.routeInfo.path.split("/")[1]??"overview";
 const detail=ctx.routeInfo.path.split("/").filter(Boolean).length>1;
  return (
    <>
      <FrameStyles />
      <nav class="frame-navigation d-flex align-items-center flex-wrap gap-2" aria-label="Frame">
        <BPRoute ctx={ctx} path="/overview">
          <bp-ok class="fw-semibold">Frame overview</bp-ok>
          <bp-noperm as="none" />
          <bp-error as="none" />
        </BPRoute>
        {groups.map((group) => (
          <details>
            <summary class={group.paths.includes(current)?"fw-semibold text-primary":""}>{group.name}</summary>
            <div class="d-flex flex-wrap gap-2 mt-2">
              {group.paths.map((path) => (
                <BPRoute ctx={ctx} path={`/${path}`}>
                  <bp-ok>{label(path)}</bp-ok>
                  <bp-noperm as="none" />
                  <bp-error as="none" />
                </BPRoute>
              ))}
            </div>
          </details>
        ))}
      </nav>
      {detail ? <BPRoute ctx={ctx} path={`/${current}`}><bp-ok class="d-inline-block small mb-3 text-decoration-none">← Back to {label(current).toLowerCase()}</bp-ok><bp-noperm as="none"/><bp-error as="none"/></BPRoute>:null}
    </>
  );
}
const columns: Record<string, [string, string, string]> = {
  Kiosks: ["Kiosk", "State", "Hardware / version"],
  Displays: ["Display", "State", "Configuration"],
  Cameras: ["Camera", "State", "Type"],
  "Camera devices": ["Device", "Connection", "Address"],
  Entities: ["Content", "Management", "Type"],
  Layouts: ["Layout", "Mode", "Grid"],
  "Diagnostic logs": ["Kiosk / time", "Level", "Message"],
  Events: ["Event", "Source", "Received"],
  Audit: ["Activity", "Result", "Time / actor"],
  Labels: ["Label", "Type", "Details"],
  "Cloud accounts": ["Account", "Provider", "Details"],
};
export function PageHeading({ title, count }: { title: string; count?: number }): HtmlRenderable {
  return (
    <header class="frame-heading">
      <h1 class="h3">{title}</h1>
      {count !== undefined ? (
        <span class="small text-body-secondary">
          {count} {count === 1 ? "item" : "items"}
        </span>
      ) : null}
    </header>
  );
}
export function ResourceTable({
  data,
  ctx,
  actions,
}: {
  data: Infer<typeof ListSchema>;
  ctx: ViewRenderContext;
  actions?: (item: Infer<typeof ListSchema>["items"][number]) => HtmlRenderable;
}): HtmlRenderable {
  const headings = columns[data.title] ?? ["Name", "State", "Details"];
  return (
    <div class="frame-table">
      <table class="table table-hover align-middle">
        <thead>
          <tr>
            {headings.map((h) => (
              <th scope="col">{h}</th>
            ))}
            {actions ? (
              <th scope="col" class="text-end">
                Actions
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr>
              <td>
                {data.detailPath ? (
                  <BPRoute ctx={ctx} path={data.detailPath} params={{ id: item.id }}>
                    <bp-ok>{item.name}</bp-ok>
                    <bp-error>{item.name}</bp-error>
                  </BPRoute>
                ) : (
                  item.name
                )}
                {item.timestamp ? <div class="small text-body-secondary mt-1"><time datetime={item.timestamp}>{new Date(item.timestamp).toLocaleString("en-GB",{timeZone:"UTC"})} UTC</time></div> : null}
              </td>
              <td>
                <span class="frame-status">{item.status || "—"}</span>
              </td>
              <td class="frame-summary">{item.summary || "—"}</td>
              {actions ? (
                <td class="text-end">
                  <div class="d-flex gap-2 justify-content-end">{actions(item)}</div>
                </td>
              ) : null}
            </tr>
          ))}
          {!data.items.length ? (
            <tr>
              <td colspan={actions ? 4 : 3}>
                <div class="frame-empty">
                  <p class="fw-semibold mb-1">No {data.title.toLowerCase()} to display</p>
                  <p class="text-body-secondary small mb-0">
                    Items you can access will appear here.
                  </p>
                </div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
export function List(data: Infer<typeof ListSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section class="frame-ui">
      <Navigation ctx={ctx} />
      <PageHeading title={data.title} count={data.items.length} />
      <ResourceTable data={data} ctx={ctx} />
    </section>
  );
}
export function Action(data: Infer<typeof ActionSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section class="frame-ui" role="status">
      <FrameStyles />
      <div class="alert alert-success">{data.message}</div>
      <BPRoute ctx={ctx} path={data.returnPath}>
        <bp-ok class="btn btn-outline-primary">Continue</bp-ok>
        <bp-error>Use the navigation to continue.</bp-error>
      </BPRoute>
    </section>
  );
}
