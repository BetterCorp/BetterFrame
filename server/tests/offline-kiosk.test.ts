import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("kiosk boot and RAUC confirmation do not wait for network-online", () => {
  for (const file of [
    "../../deploy/systemd/betterframe-kiosk.service",
    "../../deploy/systemd/betterframe-mediamtx.service",
    "../../deploy/systemd/betterframe-rauc-mark-good.service",
  ]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /network-online\.target/);
  }
});

test("persistent kiosk data is mounted before services can use it", () => {
  for (const file of [
    "../../deploy/x86-image/build-image.sh",
    "../../deploy/rauc/hook.sh",
    "../../deploy/rauc/repartition-image.sh",
  ]) {
    const script = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(script, /\/var\/lib\/betterframe[^\n]*nofail/);
  }
});

test("unpaired kiosks check signed OS updates before starting pairing", () => {
  const kiosk = readFileSync(new URL("../../kiosk/src/ui.rs", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/plugins/service-api-http/index.ts", import.meta.url), "utf8");
  assert.ok(kiosk.indexOf("os_update::check_public(&server)") < kiosk.indexOf("server::initiate_pairing(&server)"));
  assert.match(api, /\/api\/os\/public\/check/);
  assert.match(api, /\/api\/os\/public\/download\/:id/);
});

test("x86 GRUB falls back to its loaded partition when the FAT label is unavailable", () => {
  const script = readFileSync(
    new URL("../../deploy/x86-image/build-image.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /set bootpart=\$root\s+search --no-floppy --label BF_BOOT --set=bootpart/);
});

test("x86 image installs GRUB for legacy BIOS without renumbering the A/B partitions", () => {
  const script = readFileSync(
    new URL("../../deploy/x86-image/build-image.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /label: gpt\s+first-lba: 34/);
  assert.match(script, /sgdisk --set-alignment=1 --new=5:34:4095 --typecode=5:ef02/);
  assert.match(script, /grub-install --target=i386-pc .* @IMAGE_DISK@/);
});

test("Pi setup creates the kiosk user before owned directories", () => {
  const script = readFileSync(
    new URL("../../deploy/scripts/setup-pi-kiosk.sh", import.meta.url),
    "utf8",
  );
  assert.ok(script.indexOf("useradd -m") < script.indexOf("install -d -o bfkiosk"));
});

test("operator PTZ controls are capability-gated and read kiosk preset data", () => {
  const html = readFileSync(new URL("../../kiosk/operator-console/index.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../../kiosk/operator-console/app.js", import.meta.url), "utf8");
  assert.match(html, /id="ptz-controls" class="panel control-card hidden"/);
  assert.match(script, /item\.toLowerCase\(\)===\"ptz\"/);
  assert.match(script, /result\.result\?\.data\?\.presets/);
});
