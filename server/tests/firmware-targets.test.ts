import assert from "node:assert/strict";
import test from "node:test";

import {
  firmwareTargetLabel,
  normalizeFirmwareTarget,
} from "../src/shared/firmware-targets.js";
import { KioskFirmwarePanel, KioskOsUpdatePanel } from "../src/web-templates/admin-pages.js";
import type { FirmwareRelease, Kiosk } from "../src/shared/types.js";

test("normalizes legacy Rust triples to BetterFrame firmware targets", () => {
  assert.equal(normalizeFirmwareTarget("aarch64-unknown-linux-gnu"), "betterframe-rpi5-aarch64");
  assert.equal(normalizeFirmwareTarget("x86_64-unknown-linux-gnu"), "betterframe-pc-x86_64");
  assert.equal(normalizeFirmwareTarget("betterframe-rpi5-aarch64"), "betterframe-rpi5-aarch64");
  assert.equal(normalizeFirmwareTarget(""), "");
});

test("labels canonical firmware targets for admin UI", () => {
  assert.equal(firmwareTargetLabel("betterframe-rpi5-aarch64"), "Raspberry Pi 5");
  assert.equal(firmwareTargetLabel("betterframe-pc-x86_64"), "PC x86_64");
  assert.equal(firmwareTargetLabel(null), "unknown");
});

test("kiosk firmware panel only shows releases for the kiosk target", () => {
  const kiosk = {
    id: "k1",
    name: "pc-kiosk",
    kiosk_app_version: "199",
    firmware_target: "betterframe-pc-x86_64",
    firmware_channel: "stable",
    firmware_target_version: null,
  } as Kiosk;
  const releases = [
    release("200", "betterframe-rpi5-aarch64"),
    release("199", "betterframe-pc-x86_64"),
  ];

  const html = String(KioskFirmwarePanel({ kiosk, releases }));

  assert.match(html, /PC x86_64/);
  assert.match(html, /199 \(stable\)/);
  assert.doesNotMatch(html, /200 \(stable\)/);
});

test("kiosk panels show versions but hide explicitly disabled update controls", () => {
  const kiosk = {
    id: "k1",
    name: "managed-kiosk",
    kiosk_app_version: "199",
    os_version: "199",
    logging_json: JSON.stringify({ updates: { app_enabled: false, os_enabled: false } }),
  } as Kiosk;

  const app = String(KioskFirmwarePanel({ kiosk, releases: [] }));
  const os = String(KioskOsUpdatePanel({ kiosk, releases: [] }));

  assert.match(app, /Running:.*199/);
  assert.match(app, /delivered with this kiosk's OS image/);
  assert.doesNotMatch(app, /Push update now/);
  assert.match(os, /Running:.*199/);
  assert.match(os, /OS updates are disabled/);
  assert.doesNotMatch(os, /Push OS update now/);
});

function release(version: string, arch: string): FirmwareRelease {
  return {
    id: `${version}-${arch}`,
    version,
    channel: "stable",
    arch,
    artifact_path: "",
    size_bytes: 1,
    sha256: "0".repeat(64),
    signature: "",
    release_notes: null,
    uploaded_at: new Date(0).toISOString(),
    uploaded_by: null,
    yanked_at: null,
  };
}
