import Handlebars from "handlebars";
import { Script } from "node:vm";

export interface OverlayTemplate {
  id: string;
  name: string;
  html: string;
  sample_data: Record<string, unknown>;
}

export interface BlockOverlay {
  template_id: string;
  data: Record<string, unknown>;
}

export const MAX_OVERLAY_HTML = 128 * 1024;
export const MAX_OVERLAY_DATA = 32 * 1024;
export const MAX_OVERLAY_OUTPUT = 512 * 1024;
export const OVERLAY_TIMEOUT_MS = 100;
const engine = Handlebars.create();
const timedOperation = new Script("operation()");
const compiled = new Map<string, Handlebars.TemplateDelegate>();
let outputBudget: { bytes: number } | undefined;

// Handlebars exposes appendToBuffer as a compiler extension point. Instrument
// child programs too, so loop output is checked before intermediate strings grow.
const JavaScriptCompiler = (engine as any).JavaScriptCompiler;
class OverlayCompiler extends JavaScriptCompiler {
  appendToBuffer(source: unknown, location: unknown, explicit: boolean): unknown {
    return super.appendToBuffer(["helpers.__overlayOutput((", source, "),{})"], location, explicit);
  }
}
OverlayCompiler.prototype.compiler = OverlayCompiler;
(engine as any).JavaScriptCompiler = OverlayCompiler;
engine.registerHelper("__overlayOutput", (value: unknown) => {
  const text = String(value ?? "");
  if (!outputBudget) throw new Error("Overlay output budget is unavailable");
  outputBudget.bytes += Buffer.byteLength(text, "utf8");
  if (outputBudget.bytes > MAX_OVERLAY_OUTPUT) throw new Error("Rendered overlay exceeds 512 KiB output budget");
  return text;
});

/** Bound synchronous parse/compile/render work, including empty nested loops. */
function withinTimeLimit<T>(operation: () => T): T {
  try {
    return timedOperation.runInNewContext({ operation }, { timeout: OVERLAY_TIMEOUT_MS }) as T;
  } catch (cause) {
    if ((cause as { code?: string })?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error(`Overlay rendering exceeded ${OVERLAY_TIMEOUT_MS} ms`);
    }
    throw cause;
  }
}

/** Check input before parsing; runtime output has its own incremental budget. */
function templateInput(html: string): void {
  if (!html.trim()) throw new Error("Template HTML is required");
  if (Buffer.byteLength(html, "utf8") > MAX_OVERLAY_HTML) throw new Error("Template exceeds 128 KiB");
}

export function overlayData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Data must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_OVERLAY_DATA) throw new Error("Overlay data exceeds 32 KiB");
  return value as Record<string, unknown>;
}

export function blockOverlay(options: Record<string, unknown>): BlockOverlay | null {
  const value = options?.["overlay"] as Partial<BlockOverlay> | undefined;
  return value && typeof value.template_id === "string" && value.template_id
    ? { template_id: value.template_id, data: overlayData(value.data ?? {}) } : null;
}

export function validateOverlayTemplate(html: string): void {
  templateInput(html);
  withinTimeLimit(() => engine.precompile(html));
}

export function escapeOverlayAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Identical document for editor preview and playback. The host supplies the sandbox. */
export function renderOverlay(html: string, data: Record<string, unknown>): string {
  templateInput(html);
  const input = overlayData(data);
  const previousBudget = outputBudget;
  outputBudget = { bytes: 0 };
  let content: string;
  try {
    content = withinTimeLimit(() => {
      let template = compiled.get(html);
      if (!template) {
        template = engine.compile(html);
        if (compiled.size >= 32) compiled.delete(compiled.keys().next().value!);
        compiled.set(html, template);
      }
      return template(input, { allowProtoMethodsByDefault: false, allowProtoPropertiesByDefault: false });
    });
  } finally { outputBudget = previousBudget; }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}*,*::before,*::after{box-sizing:border-box}</style></head><body>${content}</body></html>`;
}

/** A native WebView must isolate authored HTML too, including injected closing tags. */
export function overlayPlaybackDocument(document: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%;pointer-events:none}</style></head><body><iframe sandbox="" srcdoc="${escapeOverlayAttribute(document)}"></iframe></body></html>`;
}

export const EXAMPLE_OVERLAY = `<style>
.status { position:absolute; left:4%; right:4%; bottom:5%; padding:1em;
  color:white; background:#111c; border-radius:.6em;
  font:clamp(12px,3vw,24px) system-ui; }
.bar { height:.6em; background:#ffffff33; border-radius:1em; overflow:hidden; margin-top:.6em; }
.fill { height:100%; width:clamp(0%,calc(var(--progress,0) * 1%),100%); background:#34d399; }
</style>
<div class="status" style="--progress: {{progress}}">
  <strong>{{name}}</strong> · {{status}} · {{progress}}%
  <div class="bar"><div class="fill"></div></div>
</div>`;
export const EXAMPLE_OVERLAY_DATA = { name: "Printer 1", status: "Printing", progress: 64 };
