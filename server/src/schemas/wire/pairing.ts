/**
 * Wire schemas for the kiosk pairing flow.
 *
 * Cross-language: imported by the Rust kiosk (`av::import_schema`) and the
 * Node-RED TypeScript custom nodes. Authored here in TypeScript and exported
 * as canonical JSON to /schemas/wire.pair_*.av.json.
 */
import * as av from "@anyvali/js";

/** Capability strings a kiosk reports. Keep this list in sync with the Rust enum. */
export const KIOSK_CAPABILITIES = [
  "display",
  "cec",
  "gpio",
  "onvif_discovery",
  "hw_decode",
] as const;

/**
 * Step 1: kiosk → server. The unpaired kiosk introduces itself and asks for a
 * pairing code. Untrusted; rate-limit at the proxy.
 */
export const pairInitiateRequest = av.object(
  {
    proposed_name: av.string().minLength(1).maxLength(128),
    hardware_model: av.optional(av.string().maxLength(128)),
    capabilities: av.array(av.enum_(KIOSK_CAPABILITIES)),
    os_version: av.optional(av.string().maxLength(128)),
    kiosk_app_version: av.optional(av.string().maxLength(64)),
    // True iff the kiosk runs our pre-built Pi OS image and ships the
    // betterframe-apply-config helper. Gates the admin Managed Config UI.
    managed_image: av.optional(av.bool()),
  },
  { unknownKeys: "reject" },
);

/**
 * Step 1 response: server → kiosk. Server allocated an 8-character code that
 * the kiosk should display on its screen for the admin to enter.
 */
export const pairInitiateResponse = av.object(
  {
    code: av.string().pattern("^[A-HJ-NP-Z2-9]{8}$"), // 0/O/1/I excluded
    expires_at: av.string().format("date-time"),
  },
  { unknownKeys: "reject" },
);

/**
 * Step 3: kiosk polls server. Body carries only the code. Three terminal
 * outcomes:
 *   - 202: still waiting for admin confirmation
 *   - 200 + body: confirmed; the response carries the kiosk_key + cluster_key
 *   - 4xx:        unknown / expired / already claimed
 */
export const pairClaimRequest = av.object(
  {
    code: av.string().pattern("^[A-HJ-NP-Z2-9]{8}$"),
  },
  { unknownKeys: "reject" },
);

/**
 * Step 3 successful response. The kiosk persists `kiosk_key` 0600 and uses it
 * as the Bearer token for all subsequent requests. `cluster_key` is the shared
 * symmetric key for camera-password decryption.
 */
export const pairClaimResponse = av.object(
  {
    kiosk_id: av.int().min(1),
    name: av.string().minLength(1).maxLength(128),
    kiosk_key: av.string().minLength(32),
    cluster_key: av.string().minLength(32),
    bundle_url: av.string().minLength(1),
  },
  { unknownKeys: "reject" },
);

export type PairInitiateRequest = av.Infer<typeof pairInitiateRequest>;
export type PairInitiateResponse = av.Infer<typeof pairInitiateResponse>;
export type PairClaimRequest = av.Infer<typeof pairClaimRequest>;
export type PairClaimResponse = av.Infer<typeof pairClaimResponse>;
