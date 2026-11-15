import { createHash } from "node:crypto";
import * as av from "anyvali";
import { smartUrlStep, type SmartUrlStep } from "../schemas/wire/smart-url.js";
import { smartUrlStepsDraft } from "./smart-url.js";
import type { Entity, LayoutCell } from "./types.js";

export const WEB_ACTION_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const schema = av.object({ on_load: av.array(smartUrlStep), groups: av.record(av.array(smartUrlStep)) }, { unknownKeys: "reject" });
export type WebActions = { on_load: SmartUrlStep[]; groups: Record<string, SmartUrlStep[]> };
export type BundleWebActions = WebActions & { revision: string };

export function parseWebActions(value: unknown): WebActions | null {
  if (value == null) return null;
  if (JSON.stringify(value).length > 256 * 1024) throw new Error("Web actions must fit in 256 KiB");
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Check web action step types, values and wait times (0–60000 ms)");
  const result = parsed.data as WebActions;
  if (Object.keys(result.groups).length > 32) throw new Error("Use at most 32 action groups per block");
  for (const name of Object.keys(result.groups)) if (!WEB_ACTION_NAME.test(name)) throw new Error("Group names must start with a letter and use letters, digits, dots, dashes or underscores (64 characters maximum)");
  for (const steps of [result.on_load, ...Object.values(result.groups)]) {
    if (steps.length > 50) throw new Error("Use at most 50 steps per sequence");
    for (const step of steps) {
      if (step.value_encrypted != null) throw new Error("Configure plain step values; the bundle encrypts fill values for each player");
      if (step.type === "navigate" && !step.url?.trim()) throw new Error("Navigation steps need a URL");
      if (["fill", "click", "wait_for"].includes(step.type) && !step.selector?.trim()) throw new Error("Form, click and wait-for steps need a selector");
    }
  }
  return result.on_load.length || Object.keys(result.groups).length ? result : null;
}

export function webActionsFormDraft(body: Record<string, string>): WebActions {
  const groups: Record<string, SmartUrlStep[]> = {};
  for (const key of Object.keys(body)) {
    const match = /^web_group_(\d+)_name$/.exec(key);
    if (!match) continue;
    const name = body[key]!.trim();
    if (!WEB_ACTION_NAME.test(name) || Object.hasOwn(groups, name)) throw new Error("Give each group a unique valid name");
    groups[name] = smartUrlStepsDraft(body, `web_group_${match[1]}_step`) as SmartUrlStep[];
  }
  return { on_load: smartUrlStepsDraft(body, "web_on_load_step") as SmartUrlStep[], groups };
}

export function bundleWebActions(cell: LayoutCell, entity?: Entity | null): BundleWebActions | undefined {
  const config = parseWebActions(cell.options?.["web_actions"]);
  if (!config) return undefined;
  const type = entity?.type ?? cell.content_type;
  if (!["web", "html", "dashboard", "ablesign"].includes(type)) return undefined;
  // Server-generated opaque binding revision: clients execute only their matching
  // cached definition, never a stale group after its content or auth changes.
  const binding = [config, cell.entity_id, type, entity?.web_url ?? cell.web_url,
    entity?.html_content ?? cell.html_content, entity?.smart_url_json ?? null,
    entity?.dashboard_id ?? null, entity?.ablesign_screen_id ?? null];
  return { ...config, revision: createHash("sha256").update(JSON.stringify(binding)).digest("hex") };
}
