/* @jsxImportSource @betterportal/framework */
import { BPRoute, type HtmlRenderable, type ViewRenderContext } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
import { Navigation, PageHeading } from "../../../ui.js";
export function render(data: Infer<typeof ResponseSchema>, ctx: ViewRenderContext): HtmlRenderable {
  const metrics = [
    { key: "kiosks", label: "Kiosks", path: "/kiosks" },
    { key: "displays", label: "Displays", path: "/displays" },
    { key: "cameras", label: "Cameras", path: "/cameras" },
    { key: "layouts", label: "Layouts", path: "/layouts" },
    { key: "ioBoxes", label: "IO boxes", path: "/iobox" },
  ] as const;
  return (
    <section class="frame-ui">
      <Navigation ctx={ctx} />
      <PageHeading title={data.title} />
      <p class="frame-section-note">Manage your fleet, display content and device activity.</p>
      <div class="row g-3">
        {metrics.map((metric) => (
          <div class="col-sm-6 col-lg-4">
            <article class="card h-100">
              <div class="card-body p-4">
                <h2 class="h6 text-body-secondary">{metric.label}</h2>
                <p class="display-6 fw-semibold mb-3">{data[metric.key]}</p>
                <BPRoute ctx={ctx} path={metric.path}>
                  <bp-ok>View {metric.label.toLowerCase()} →</bp-ok>
                  <bp-noperm as="none" />
                  <bp-error as="none" />
                </BPRoute>
              </div>
            </article>
          </div>
        ))}
      </div>
    </section>
  );
}
