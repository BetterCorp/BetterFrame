import { Layout } from "./layout.js";
import { blockOverlay, escapeOverlayAttribute as esc, EXAMPLE_OVERLAY, EXAMPLE_OVERLAY_DATA, type OverlayTemplate } from "../shared/overlays.js";
import type { LayoutCell } from "../shared/types.js";

export interface OverlayTemplateDraft { name: string; html: string; sample_data: string }
export interface BlockOverlayDraft { template_id: string; data: string }

export function OverlayTemplatesPage(props: { user?: string; templates: OverlayTemplate[]; template?: OverlayTemplate; error?: string; draft?: OverlayTemplateDraft }) {
  const t = props.template ?? { id: "new", name: "", html: EXAMPLE_OVERLAY, sample_data: EXAMPLE_OVERLAY_DATA };
  const draft = props.draft ?? { name: t.name, html: t.html, sample_data: JSON.stringify(t.sample_data, null, 2) };
  return <Layout title="Overlay templates" user={props.user} activeNav="overlays">
    <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">
      <a class="btn" href="/admin/overlays">New template</a>
      {props.templates.map(item => <a class="btn" href={`/admin/overlays/${item.id}`}>{esc(item.name)}</a>)}
    </div>
    {props.error ? <p role="alert">{esc(props.error)}</p> : ""}
    <form method="post" action={`/admin/overlays/${t.id}`} id="overlay-editor">
      <div class="form-group"><label for="overlay-name">Name</label><input id="overlay-name" class="form-input" name="name" value={draft.name} required maxlength="128" /></div>
      <div class="overlay-editor-columns">
        <div>
          <div class="form-group"><label for="overlay-html">HTML / CSS / Handlebars</label><textarea id="overlay-html" name="html" class="form-input" rows="20" spellcheck="false">{esc(draft.html)}</textarea></div>
          <div class="form-group"><label for="overlay-sample">Sample JSON data (preview only)</label><textarea id="overlay-sample" name="sample_data" class="form-input" rows="7" spellcheck="false">{esc(draft.sample_data)}</textarea></div>
          <button class="btn btn-primary" type="submit">Save template</button>
        </div>
        <div>
          <label for="overlay-size">Preview size</label>
          <select id="overlay-size" class="form-input"><option value="640,360">Wide · 640 × 360</option><option value="320,320">Square · 320 × 320</option><option value="240,480">Portrait · 240 × 480</option></select>
          <p>Resize the preview using its bottom corner. CSS sizes follow this area.</p>
          <div id="overlay-preview-error" role="alert" aria-live="polite"></div>
          <div class="overlay-preview-resize"><iframe id="overlay-preview" title="Overlay live preview" sandbox="" referrerpolicy="no-referrer"></iframe></div>
        </div>
      </div>
    </form>
    {t.id !== "new" ? <form method="post" action={`/admin/overlays/${t.id}/delete`} style="margin-top:1rem"><button class="btn btn-danger" type="submit">Delete template</button></form> : ""}
    <link rel="stylesheet" href="/static/overlay-editor.css" />
    <script src="/static/overlay-editor.js" defer></script>
  </Layout>;
}

export function BlockOverlayEditor(props: { cell: LayoutCell; templates: OverlayTemplate[]; saved?: boolean; error?: string; draft?: BlockOverlayDraft }) {
  let error = props.error;
  try { blockOverlay(props.cell.options); }
  catch { error ??= "Stored overlay data is invalid. Update the data or remove the overlay."; }
  const stored = props.cell.options?.["overlay"] as { template_id?: unknown; data?: unknown } | undefined;
  const draft = props.draft ?? {
    template_id: typeof stored?.template_id === "string" ? stored.template_id : "",
    data: JSON.stringify(stored?.data ?? {}, null, 2),
  };
  return <div id={`block-overlay-${props.cell.id}`}>
    <hr /><h3>Overlay</h3>
    {error ? <p role="alert">{esc(error)}</p> : ""}
    <form method="post" action={`/admin/overlays/blocks/${props.cell.id}`} hx-post={`/admin/overlays/blocks/${props.cell.id}`} hx-target={`#block-overlay-${props.cell.id}`} hx-swap="outerHTML">
      <div class="form-group"><label>Template</label><select name="template_id" class="form-input"><option value="" selected={!draft.template_id}>No overlay</option>{draft.template_id && !props.templates.some(t => t.id === draft.template_id) ? <option value={draft.template_id} selected>Missing template</option> : ""}{props.templates.map(t => <option value={t.id} selected={draft.template_id === t.id}>{esc(t.name)}</option>)}</select></div>
      <div class="form-group"><label>Live JSON data</label><textarea name="data" class="form-input" rows="6">{esc(draft.data)}</textarea></div>
      <p>Block ID: <code>{esc(props.cell.id)}</code></p>
      <button class="btn btn-primary" type="submit">Save overlay</button> <a href="/admin/overlays">Edit templates</a>
      {props.saved ? <p role="status">Overlay saved</p> : ""}
    </form>
  </div>;
}
