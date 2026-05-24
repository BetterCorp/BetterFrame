/**
 * Cloud camera integrations — auto-register all vendor providers.
 */
export { type CloudAccount, type CloudCamera, type CloudVendor, type CloudCameraProvider,
  CLOUD_VENDORS, VENDOR_LABELS, getProvider, listProviders, registerProvider } from "./types.js";

import { registerProvider } from "./types.js";
import { HikConnectProvider } from "./hikconnect.js";
import { EzvizProvider } from "./ezviz.js";
import { DahuaProvider } from "./dahua.js";
import { TuyaProvider } from "./tuya.js";
import { UniviewProvider } from "./uniview.js";
import { TpLinkProvider } from "./tplink.js";
import { ReolinkProvider } from "./reolink.js";
import { EagleEyeProvider } from "./eagle-eye.js";

registerProvider(new HikConnectProvider());
registerProvider(new EzvizProvider());
registerProvider(new DahuaProvider());
registerProvider(new TuyaProvider());
registerProvider(new UniviewProvider());
registerProvider(new TpLinkProvider());
registerProvider(new ReolinkProvider());
registerProvider(new EagleEyeProvider());
