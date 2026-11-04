/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import { ListSchema, ActionSchema } from "./models.js";
const sections = [
  "overview",
  "cameras",
  "camera-devices",
  "entities",
  "layouts",
  "displays",
  "kiosks",
  "iobox",
  "labels",
  "logs",
  "events",
  "audit",
  "cloud-accounts",
  "ablesign",
  "firmware",
  "os-updates",
  "settings",
];
export function Navigation({ ctx }: { ctx: ViewRenderContext }): HtmlRenderable {
  return (
    <nav class="d-flex flex-wrap gap-3 mb-4" aria-label="Frame">
      {sections.map((path) => (
        <BPRoute ctx={ctx} path={`/${path}`}>
          <bp-ok>{path.replaceAll("-", " ")}</bp-ok>
          <bp-noperm as="none"></bp-noperm>
          <bp-error as="none"></bp-error>
        </BPRoute>
      ))}
    </nav>
  );
}
export function List(data: Infer<typeof ListSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section>
      <Navigation ctx={ctx} />
      <h1 class="h3">{data.title}</h1>
      <div class="table-responsive">
        <table class="table align-middle">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Details</th>
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
                </td>
                <td>{item.status}</td>
                <td>{item.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.items.length ? <p class="text-body-secondary">No items yet.</p> : null}
      </div>
    </section>
  );
}
export function Action(data: Infer<typeof ActionSchema>, ctx: ViewRenderContext): HtmlRenderable {
  return (
    <section role="status">
      <div class="alert alert-success">{data.message}</div>
      <BPRoute ctx={ctx} path={data.returnPath}>
        <bp-ok>Continue</bp-ok>
        <bp-error>Use the navigation to continue.</bp-error>
      </BPRoute>
    </section>
  );
}
