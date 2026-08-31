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
