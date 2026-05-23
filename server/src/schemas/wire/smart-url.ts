/**
 * Smart URL action steps — automated browser sequences for web cells.
 *
 * When a web cell has smart_url_steps in its options, the kiosk's WebKit
 * executes each step in order before displaying the final page. Use cases:
 *   - Login to a dashboard (navigate → fill form → click → wait → navigate)
 *   - Accept cookie banners
 *   - Navigate through multi-step wizards
 *   - Auto-refresh on session expiry (detect redirect → re-run sequence)
 *
 * Steps are authored in the admin UI's cell editor and delivered via the
 * bundle. Credentials in "fill" steps are encrypted with the per-kiosk
 * encryption key.
 */
import * as av from "@anyvali/js";

export const SMART_URL_STEP_TYPES = [
  "navigate",   // Go to a URL
  "fill",       // Fill a form field (CSS selector + value)
  "click",      // Click an element (CSS selector)
  "wait",       // Wait N milliseconds
  "wait_for",   // Wait for an element to appear (CSS selector, max timeout)
  "javascript", // Execute arbitrary JS (power-user escape hatch)
] as const;

export const smartUrlStep = av.object(
  {
    type: av.enum_(SMART_URL_STEP_TYPES),
    // "navigate": URL to load
    url: av.optional(av.string().maxLength(2048)),
    // "fill": CSS selector for the input + value to set
    selector: av.optional(av.string().maxLength(512)),
    value: av.optional(av.string().maxLength(1024)),
    // "fill" with encrypted value (per-kiosk key). Kiosk decrypts at runtime.
    value_encrypted: av.optional(av.string().maxLength(2048)),
    // "click": CSS selector to click
    // (reuses `selector` field)
    // "wait": milliseconds
    delay_ms: av.optional(av.int().min(0).max(60000)),
    // "wait_for": CSS selector + timeout
    timeout_ms: av.optional(av.int().min(0).max(60000)),
    // "javascript": raw JS to evaluate
    script: av.optional(av.string().maxLength(10000)),
  },
  { unknownKeys: "strip" },
);

export const smartUrlConfig = av.object(
  {
    steps: av.array(smartUrlStep),
    // Re-run the sequence when the page redirects to a login URL.
    // Substring match on the current URL — if detected, sequence restarts.
    login_detect_url: av.optional(av.string().maxLength(2048)),
    // Interval to check for session expiry (ms). 0 = disabled.
    session_check_interval_ms: av.optional(av.int().min(0).max(3600000)),
  },
  { unknownKeys: "strip" },
);

export type SmartUrlStep = av.Infer<typeof smartUrlStep>;
export type SmartUrlConfig = av.Infer<typeof smartUrlConfig>;
