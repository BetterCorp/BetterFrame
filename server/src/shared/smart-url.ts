import { smartUrlConfig, type SmartUrlConfig } from "../schemas/wire/smart-url.js";

/** Parse the entity's step builder, including gaps left by deleted rows. */
export function smartUrlFormDraft(body: Record<string, string>): SmartUrlConfig {
  const indices = Object.keys(body).flatMap((key) => {
    const match = /^step_(\d+)_type$/.exec(key);
    return match ? [Number(match[1])] : [];
  }).sort((a, b) => a - b);
  const steps = indices.map((index) => {
    const type = body[`step_${index}_type`]!;
    const value = body[`step_${index}_value`] ?? "";
    if (type === "navigate") return { type, url: value };
    if (type === "fill") {
      // Attribute selectors commonly contain '=' (input[name="username"]).
      let equal = -1, depth = 0;
      let quote = "", escaped = false;
      for (let i = 0; i < value.length; i++) {
        const char = value[i]!;
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (quote) { if (char === quote) quote = ""; continue; }
        if (char === "\"" || char === "'") { quote = char; continue; }
        if (char === "[" || char === "(") depth++;
        if (char === "]" || char === ")") depth--;
        if (char === "=" && depth === 0) { equal = i; break; }
      }
      return { type, selector: equal < 0 ? value : value.slice(0, equal), value: equal < 0 ? "" : value.slice(equal + 1) };
    }
    if (type === "wait") return { type, delay_ms: value.trim() === "" ? 1000 : Number(value) };
    if (type === "javascript") return { type, script: value };
    return { type, selector: value };
  });
  return { steps, login_detect_url: (body["smart_url_login_detect"] ?? "").trim() } as SmartUrlConfig;
}

export function parseSmartUrlForm(body: Record<string, string>): SmartUrlConfig | null {
  const draft = smartUrlFormDraft(body);
  if (!draft.steps.length) return null;
  if (draft.steps.length > 50) throw new Error("Use at most 50 authentication steps.");
  const prefix = draft.login_detect_url ?? "";
  if (!prefix || (!prefix.startsWith("/") && !/^https?:\/\//i.test(prefix))) {
    throw new Error("Authentication steps need a login URL prefix, such as /auth or https://example.com/login.");
  }
  const result = smartUrlConfig.safeParse(draft);
  if (!result.success) throw new Error("Check the authentication step types, lengths and wait times (0–60000 ms).");
  for (const step of result.data.steps) {
    if ((step.type === "navigate" && !step.url?.trim()) ||
        (["fill", "click", "wait_for"].includes(step.type) && !step.selector?.trim())) {
      throw new Error("Each navigation needs a URL and each form action needs a selector.");
    }
  }
  return result.data;
}
