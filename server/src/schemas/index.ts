/**
 * Schema registry. Single source of truth for which schemas exist and what
 * they're called when exported to /schemas/<key>.av.json.
 *
 * Keys use dotted namespaces:
 *   wire.*  cross-language wire contracts (kiosk, node-red consume these)
 *   forms.* HTML form bodies (browser + server consume these)
 *
 * Add new schemas here and run `npm run schemas:export`.
 */
import type { BaseSchema } from "anyvali";

import { passwordChangeForm, totpConfirmForm, totpDisableForm } from "./forms/account.js";
import {
  cameraCreateForm,
  kioskPairConfirmForm,
  labelCreateForm,
} from "./forms/admin.js";
import { loginForm, recoveryForm, setupForm, totpForm } from "./forms/auth.js";
import { kioskBundle } from "./wire/bundle.js";
import {
  kioskEvent,
  kioskEventResponse,
  kioskHeartbeat,
  kioskHeartbeatResponse,
} from "./wire/events.js";
import {
  pairClaimRequest,
  pairClaimResponse,
  pairInitiateRequest,
  pairInitiateResponse,
} from "./wire/pairing.js";

// `BaseSchema<unknown, any>` so heterogeneous schemas fit in one map.
// We never read .Output through the registry — handlers import the named
// schema directly when they care about types.
type AnySchema = BaseSchema<unknown, unknown>;

export const schemas = {
  // Forms
  "forms.setup": setupForm as AnySchema,
  "forms.login": loginForm as AnySchema,
  "forms.totp": totpForm as AnySchema,
  "forms.recovery": recoveryForm as AnySchema,
  "forms.password_change": passwordChangeForm as AnySchema,
  "forms.totp_confirm": totpConfirmForm as AnySchema,
  "forms.totp_disable": totpDisableForm as AnySchema,
  "forms.camera_create": cameraCreateForm as AnySchema,
  "forms.kiosk_pair_confirm": kioskPairConfirmForm as AnySchema,
  "forms.label_create": labelCreateForm as AnySchema,

  // Wire
  "wire.pair_initiate": pairInitiateRequest as AnySchema,
  "wire.pair_initiate_response": pairInitiateResponse as AnySchema,
  "wire.pair_claim": pairClaimRequest as AnySchema,
  "wire.pair_claim_response": pairClaimResponse as AnySchema,
  "wire.kiosk_bundle": kioskBundle as AnySchema,
  "wire.kiosk_heartbeat": kioskHeartbeat as AnySchema,
  "wire.kiosk_heartbeat_response": kioskHeartbeatResponse as AnySchema,
  "wire.kiosk_event": kioskEvent as AnySchema,
  "wire.kiosk_event_response": kioskEventResponse as AnySchema,
} as const;

export type SchemaKey = keyof typeof schemas;

export function getSchema(key: SchemaKey): AnySchema {
  return schemas[key];
}
