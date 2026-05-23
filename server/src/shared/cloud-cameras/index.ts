/**
 * Cloud camera integrations — auto-register all vendor providers.
 */
export { type CloudAccount, type CloudCamera, type CloudVendor, type CloudCameraProvider,
  CLOUD_VENDORS, VENDOR_LABELS, getProvider, listProviders, registerProvider } from "./types.js";

import { registerProvider } from "./types.js";
import { HikConnectProvider } from "./hikconnect.js";
import { DahuaProvider } from "./dahua.js";
import { TuyaProvider } from "./tuya.js";
import { UniviewProvider } from "./uniview.js";
import { TpLinkProvider } from "./tplink.js";

registerProvider(new HikConnectProvider());
registerProvider(new DahuaProvider());
registerProvider(new TuyaProvider());
registerProvider(new UniviewProvider());
registerProvider(new TpLinkProvider());
