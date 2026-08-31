import assert from "node:assert/strict";
import test from "node:test";

import { performAction, type SoapTransport } from "../src/shared/onvif.js";

test("ONVIF GetPresets returns named preset tokens", async () => {
  const soapTransport: SoapTransport = async (_url, action) => {
    if (action.endsWith("/GetCapabilities")) {
      return `<Capabilities><Media><XAddr>http://camera/media</XAddr></Media><PTZ><XAddr>http://camera/ptz</XAddr></PTZ></Capabilities>`;
    }
    if (action.endsWith("/GetProfiles")) {
      return `<GetProfilesResponse><Profiles token="profile-1"><Name>Main</Name><PTZConfiguration token="ptz-1"/></Profiles></GetProfilesResponse>`;
    }
    if (action.endsWith("/GetPresets")) {
      return `<GetPresetsResponse><Preset token="1"><Name>Gate</Name></Preset><Preset token="2"><Name>Driveway</Name></Preset></GetPresetsResponse>`;
    }
    throw new Error(`unexpected SOAP action: ${action}`);
  };

  const result = await performAction({
    host: "camera",
    port: 80,
    username: "",
    password: "",
    action: "ptz.get_presets",
    params: { profileToken: "profile-1" },
    soapTransport,
  });

  assert.deepEqual(result.data?.["presets"], [
    { token: "1", name: "Gate" },
    { token: "2", name: "Driveway" },
  ]);
});
