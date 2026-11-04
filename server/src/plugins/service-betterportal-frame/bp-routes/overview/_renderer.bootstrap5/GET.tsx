/* @jsxImportSource @betterportal/framework */
import type { HtmlRenderable } from "@betterportal/framework";
import type { Infer } from "anyvali";
import type { ResponseSchema } from "../GET.js";
export function render(data: Infer<typeof ResponseSchema>): HtmlRenderable {
  return (
    <section>
      <h1 class="h3">{data.title}</h1>
      <div class="row g-3">
        {Object.entries(data)
          .filter(([key]) => key !== "title")
          .map(([key, count]) => (
            <div class="col-sm-6 col-lg-3">
              <div class="card">
                <div class="card-body">
                  <h2 class="h6 text-capitalize">{key}</h2>
                  <p class="display-6 mb-0">{count}</p>
                </div>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}
