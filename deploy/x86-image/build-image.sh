#!/usr/bin/env bash
set -euo pipefail

KIOSK_BIN="${1:?kiosk binary path required}"
OUT_IMG_XZ="${2:?output .img.xz path required}"
VERSION="${3:?version required}"
ROOTFS_OUT="${4:-}"
BOOTFS_OUT="${5:-}"
IMAGE_CHANNEL="${BF_IMAGE_CHANNEL:-stable}"

case "$IMAGE_CHANNEL" in stable|beta|dev) ;; *) echo "invalid BF_IMAGE_CHANNEL" >&2; exit 1 ;; esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'set +e; cleanup' EXIT

cleanup() {
  if [ -d "${WORK}/root" ]; then
    umount -R "${WORK}/root" 2>/dev/null || true
  fi
  for p in dev/pts dev proc sys run boot/efi; do
    if mountpoint -q "${WORK}/root/${p}"; then umount -lf "${WORK}/root/${p}"; fi
  done
  if [ -n "${LOOP:-}" ]; then losetup -d "$LOOP" 2>/dev/null || true; fi
  rm -rf "$WORK"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "build-image.sh must run as root" >&2
    exit 1
  fi
}

quiet_cmdline="quiet splash plymouth.ignore-serial-consoles loglevel=0 vt.global_cursor_default=0 logo.nologo systemd.unit=multi-user.target"

require_root

IMG="${WORK}/betterframe-pc.img"
ESP_MB=512
ROOT_MB="${BF_X86_ROOT_MB:-6144}"
DATA_MB="${BF_X86_DATA_MB:-512}"
TOTAL_MB=$((ESP_MB + ROOT_MB * 2 + DATA_MB + 64))

echo "==> Allocating ${TOTAL_MB} MiB x86 UEFI image"
truncate -s "${TOTAL_MB}M" "$IMG"

sfdisk "$IMG" <<SFDISK
label: gpt
start=2048, size=$((ESP_MB * 2048)), type=U, name="BF_BOOT"
size=$((ROOT_MB * 2048)), type=L, name="BF_ROOT_A"
size=$((ROOT_MB * 2048)), type=L, name="BF_ROOT_B"
type=L, name="BF_DATA"
SFDISK

LOOP="$(losetup --find --partscan --show "$IMG")"
udevadm settle || true

mkfs.vfat -F32 -n BF_BOOT "${LOOP}p1"
mkfs.ext4 -F -L BF_ROOT_A "${LOOP}p2"
mkfs.ext4 -F -L BF_ROOT_B "${LOOP}p3"
mkfs.ext4 -F -L BF_DATA "${LOOP}p4"

partuuid() {
  blkid -s PARTUUID -o value "$1" | tr '[:upper:]' '[:lower:]'
}

PARTUUID_BOOT="$(partuuid "${LOOP}p1")"
PARTUUID_ROOT_A="$(partuuid "${LOOP}p2")"
PARTUUID_ROOT_B="$(partuuid "${LOOP}p3")"
PARTUUID_DATA="$(partuuid "${LOOP}p4")"

mkdir -p "${WORK}/root"
mount "${LOOP}p2" "${WORK}/root"
mkdir -p "${WORK}/root/boot/efi"
mount "${LOOP}p1" "${WORK}/root/boot/efi"

echo "==> Bootstrapping Debian trixie amd64"
debootstrap --arch=amd64 trixie "${WORK}/root" http://deb.debian.org/debian
cp /etc/resolv.conf "${WORK}/root/etc/resolv.conf"

mount --bind /dev "${WORK}/root/dev"
mount --bind /dev/pts "${WORK}/root/dev/pts"
mount -t proc proc "${WORK}/root/proc"
mount -t sysfs sys "${WORK}/root/sys"
mount -t tmpfs tmpfs "${WORK}/root/run"

cp "$KIOSK_BIN" "${WORK}/root/tmp/betterframe-kiosk"
mkdir -p "${WORK}/root/tmp/bf-files"
cp "${REPO_ROOT}/deploy/systemd/betterframe-kiosk.service" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-firmware-rollback.sh" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-rauc-mark-good.service" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-rauc-mark-good.sh" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-expand-data.service" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-expand-data.sh" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-apply-managed-config.sh" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-seal-key.service" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/systemd/betterframe-seal-key.sh" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/scripts/randomize-image-users.sh" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/tmpfiles/betterframe-kiosk.conf" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/udev/90-betterframe-no-hid.rules" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/pam.d/cage" "${WORK}/root/tmp/bf-files/cage.pam"
cp "${REPO_ROOT}/deploy/rauc/system-x86.conf" "${WORK}/root/tmp/bf-files/rauc-system.conf"
cp "${REPO_ROOT}/deploy/systemd/rauc.service" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/dbus/de.pengutronix.rauc.service" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/dbus/de.pengutronix.rauc.conf" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/nftables/nftables.conf" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/cursor-theme/betterframe-empty/cursor.theme" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/plymouth/betterframe/betterframe.plymouth" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/deploy/plymouth/betterframe/betterframe.script" "${WORK}/root/tmp/bf-files/"
cp "${REPO_ROOT}/server/src/web-static/betterframe-logo.svg" "${WORK}/root/tmp/bf-files/"
if [ -f "${REPO_ROOT}/deploy/rauc/ca-cert.pem" ]; then
  cp "${REPO_ROOT}/deploy/rauc/ca-cert.pem" "${WORK}/root/tmp/bf-files/rauc-keyring.pem"
fi
sed -i \
  -e "s|/dev/disk/by-partlabel/BF_ROOT_A|/dev/disk/by-partuuid/${PARTUUID_ROOT_A}|g" \
  -e "s|/dev/disk/by-partlabel/BF_ROOT_B|/dev/disk/by-partuuid/${PARTUUID_ROOT_B}|g" \
  "${WORK}/root/tmp/bf-files/rauc-system.conf"

cat > "${WORK}/root/etc/fstab" <<FSTAB
PARTUUID=${PARTUUID_BOOT}    /boot/efi             vfat  defaults  0  2
PARTUUID=${PARTUUID_ROOT_A}  /                    ext4  defaults,noatime  0  1
PARTUUID=${PARTUUID_DATA}    /var/lib/betterframe ext4  defaults,noatime,nofail  0  2
FSTAB

printf 'betterframe-kiosk\n' > "${WORK}/root/etc/hostname"
cat > "${WORK}/root/etc/hosts" <<'HOSTS'
127.0.0.1 localhost
127.0.1.1 betterframe-kiosk
HOSTS

cat > "${WORK}/root/tmp/install-betterframe-x86.sh" <<'CHROOT'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get -y install --no-install-recommends \
  linux-image-amd64 systemd-sysv dbus sudo locales ca-certificates curl gnupg \
  python3 initramfs-tools \
  grub-efi-amd64 grub-efi-amd64-bin grub-common shim-signed grub-efi-amd64-signed \
  cage seatd plymouth plymouth-themes librsvg2-bin \
  libgtk-4-1 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libwebkitgtk-6.0-4 \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-libav gstreamer1.0-tools v4l-utils wlr-randr \
  gstreamer1.0-vaapi va-driver-all mesa-va-drivers vainfo intel-gpu-tools \
  rauc dosfstools nftables cloud-guest-utils e2fsprogs openssl udev tpm2-tools

locale-gen en_US.UTF-8 || true
update-locale LANG=en_US.UTF-8 || true

if ! id -u bfadmin >/dev/null 2>&1; then useradd -m -s /usr/sbin/nologin bfadmin; fi
if ! id -u bfkiosk >/dev/null 2>&1; then useradd -m -s /usr/sbin/nologin bfkiosk; fi
for grp in video render input audio systemd-journal tss; do
  getent group "$grp" >/dev/null && usermod -a -G "$grp" bfkiosk
done

install -d -o bfkiosk -g bfkiosk -m 755 /opt/betterframe/kiosk
install -m 755 /tmp/betterframe-kiosk /opt/betterframe/kiosk/betterframe-kiosk
install -d -o bfkiosk -g bfkiosk -m 755 /var/lib/betterframe/kiosk
install -d -m 755 /etc/betterframe
printf '%s\n' "@VERSION@" > /etc/betterframe/os-version
printf '%s\n' "betterframe-x86_64-generic" > /etc/betterframe/os-compatibility

install -m 644 /tmp/bf-files/betterframe-kiosk.service /etc/systemd/system/betterframe-kiosk.service
install -m 644 /tmp/bf-files/cage.pam /etc/pam.d/cage
install -m 755 /tmp/bf-files/betterframe-firmware-rollback.sh /usr/local/sbin/betterframe-firmware-rollback.sh
install -m 644 /tmp/bf-files/betterframe-rauc-mark-good.service /etc/systemd/system/betterframe-rauc-mark-good.service
install -m 755 /tmp/bf-files/betterframe-rauc-mark-good.sh /usr/local/sbin/betterframe-rauc-mark-good.sh
install -m 644 /tmp/bf-files/betterframe-expand-data.service /etc/systemd/system/betterframe-expand-data.service
install -m 755 /tmp/bf-files/betterframe-expand-data.sh /usr/local/sbin/betterframe-expand-data.sh
install -m 755 /tmp/bf-files/betterframe-apply-managed-config.sh /usr/local/sbin/betterframe-apply-managed-config.sh
install -m 644 /tmp/bf-files/betterframe-seal-key.service /etc/systemd/system/betterframe-seal-key.service
install -m 755 /tmp/bf-files/betterframe-seal-key.sh /usr/local/sbin/betterframe-seal-key.sh
install -d -m 755 /etc/systemd/system/betterframe-kiosk.service.d
cat > /etc/systemd/system/betterframe-kiosk.service.d/tpm-storage.conf <<'TPMUNIT'
[Unit]
Requires=betterframe-seal-key.service
After=betterframe-seal-key.service
TPMUNIT
install -m 755 /tmp/bf-files/randomize-image-users.sh /usr/local/sbin/randomize-image-users.sh
install -m 644 /tmp/bf-files/betterframe-kiosk.conf /etc/tmpfiles.d/betterframe-kiosk.conf
install -m 644 /tmp/bf-files/90-betterframe-no-hid.rules /etc/udev/rules.d/90-betterframe-no-hid.rules

install -d -m 755 /etc/rauc
install -m 644 /tmp/bf-files/rauc-system.conf /etc/rauc/system.conf
[ -f /tmp/bf-files/rauc-keyring.pem ] && install -m 644 /tmp/bf-files/rauc-keyring.pem /etc/rauc/keyring.pem
install -m 644 /tmp/bf-files/rauc.service /etc/systemd/system/rauc.service
install -d -m 755 /usr/share/dbus-1/system-services /usr/share/dbus-1/system.d
install -m 644 /tmp/bf-files/de.pengutronix.rauc.service /usr/share/dbus-1/system-services/de.pengutronix.rauc.service
install -m 644 /tmp/bf-files/de.pengutronix.rauc.conf /usr/share/dbus-1/system.d/de.pengutronix.rauc.conf

install -m 644 /tmp/bf-files/nftables.conf /etc/nftables.conf
install -d -m 755 /etc/sudoers.d
cat > /etc/sudoers.d/betterframe-managed-config <<'SUDOERS'
bfkiosk ALL=(root) NOPASSWD: /usr/local/sbin/betterframe-apply-managed-config.sh *
SUDOERS
chmod 440 /etc/sudoers.d/betterframe-managed-config
cat > /etc/sudoers.d/betterframe-reboot <<'SUDOERS'
bfkiosk ALL=(root) NOPASSWD: /usr/sbin/reboot 0 tryboot, /usr/bin/systemctl reboot
SUDOERS
chmod 440 /etc/sudoers.d/betterframe-reboot

cat > /etc/default/betterframe-kiosk <<'EOF'
BF_ENABLE_APP_OTA=0
BF_ENABLE_OS_OTA=1
BF_ENABLE_ONVIF_EVENTS=1
BF_FIRMWARE_CHANNEL=@CHANNEL@
EOF

install -d -m 755 /usr/share/plymouth/themes/betterframe
install -m 644 /tmp/bf-files/betterframe.plymouth /usr/share/plymouth/themes/betterframe/betterframe.plymouth
install -m 644 /tmp/bf-files/betterframe.script /usr/share/plymouth/themes/betterframe/betterframe.script
rsvg-convert -w 480 /tmp/bf-files/betterframe-logo.svg -o /usr/share/plymouth/themes/betterframe/logo.png
plymouth-set-default-theme betterframe || true

CURSOR_DIR=/usr/share/icons/betterframe-empty/cursors
install -d -m 755 "$CURSOR_DIR"
install -m 644 /tmp/bf-files/cursor.theme /usr/share/icons/betterframe-empty/index.theme
install -m 644 /tmp/bf-files/cursor.theme /usr/share/icons/betterframe-empty/cursor.theme
python3 - <<'PY'
import os, struct
cursor_dir = "/usr/share/icons/betterframe-empty/cursors"
hdr = b"Xcur" + struct.pack("<III", 16, 0x00010000, 1)
toc = struct.pack("<III", 0xfffd0002, 1, 28)
img = struct.pack("<IIIIIIIII", 36, 0xfffd0002, 1, 1, 1, 1, 0, 0, 0)
data = hdr + toc + img + struct.pack("<I", 0)
for name in ["default","left_ptr","arrow","watch","hand2","text","xterm"]:
    open(os.path.join(cursor_dir, name), "wb").write(data)
PY

mkdir -p /etc/systemd/timesyncd.conf.d /etc/systemd/logind.conf.d
cat > /etc/systemd/timesyncd.conf.d/betterframe.conf <<'NTP'
[Time]
NTP=0.pool.ntp.org 1.pool.ntp.org 2.pool.ntp.org 3.pool.ntp.org
FallbackNTP=time.google.com time.cloudflare.com
NTP
cat > /etc/systemd/logind.conf.d/betterframe-lockdown.conf <<'LOGIND'
[Login]
NAutoVTs=0
ReserveVT=0
LOGIND

systemctl enable systemd-timesyncd seatd nftables betterframe-seal-key betterframe-kiosk betterframe-rauc-mark-good betterframe-expand-data rauc 2>/dev/null || true
systemctl set-default multi-user.target
for dm in lightdm gdm gdm3 sddm; do systemctl disable "$dm.service" 2>/dev/null || true; systemctl mask "$dm.service" 2>/dev/null || true; done
for tty in 1 2 3 4 5 6; do systemctl disable "getty@tty${tty}.service" 2>/dev/null || true; systemctl mask "getty@tty${tty}.service" 2>/dev/null || true; done
systemctl mask serial-getty@.service getty@.service ctrl-alt-del.target emergency.service rescue.service emergency.target rescue.target grub-common.service 2>/dev/null || true
systemctl disable ssh.service ssh.socket 2>/dev/null || true
systemctl mask ssh.service ssh.socket 2>/dev/null || true

mkdir -p /boot/efi/EFI/betterframe /boot/efi/EFI/BOOT
grub-editenv /boot/efi/EFI/betterframe/grubenv create
grub-editenv /boot/efi/EFI/betterframe/grubenv set ORDER="A B" A_OK=1 A_TRY=0 B_OK=0 B_TRY=0
cat > /boot/efi/EFI/betterframe/grub.cfg <<'GRUB'
set timeout=3
set default=0
set any_ok=0
set ORDER="A B"
set A_OK=0
set B_OK=0
set A_TRY=0
set B_TRY=0
search --no-floppy --label BF_BOOT --set=bootpart
load_env --file=($bootpart)/EFI/betterframe/grubenv
for SLOT in $ORDER; do
  if [ "$SLOT" = "A" ]; then
    set INDEX=0
    set OK=$A_OK
    set TRY=$A_TRY
    set A_TRY=1
  fi
  if [ "$SLOT" = "B" ]; then
    set INDEX=1
    set OK=$B_OK
    set TRY=$B_TRY
    set B_TRY=1
  fi
  if [ "$OK" -eq 1 -a "$TRY" -eq 0 ]; then
    set default=$INDEX
    set any_ok=1
    break
  fi
done
if [ "$any_ok" -eq 0 ]; then
  if [ "$A_OK" -eq 1 -a "$A_TRY" -eq 1 ]; then
    set A_TRY=0
  fi
  if [ "$B_OK" -eq 1 -a "$B_TRY" -eq 1 ]; then
    set B_TRY=0
  fi
fi
save_env --file=($bootpart)/EFI/betterframe/grubenv A_TRY B_TRY
menuentry "BetterFrame A" {
  search --no-floppy --partuuid @PARTUUID_ROOT_A@ --set=root
  linux /vmlinuz root=PARTUUID=@PARTUUID_ROOT_A@ ro rauc.slot=A loglevel=4 systemd.show_status=1 plymouth.enable=0 vt.global_cursor_default=0 logo.nologo systemd.unit=multi-user.target
  initrd /initrd.img
}
menuentry "BetterFrame B" {
  search --no-floppy --partuuid @PARTUUID_ROOT_B@ --set=root
  linux /vmlinuz root=PARTUUID=@PARTUUID_ROOT_B@ ro rauc.slot=B loglevel=4 systemd.show_status=1 plymouth.enable=0 vt.global_cursor_default=0 logo.nologo systemd.unit=multi-user.target
  initrd /initrd.img
}
menuentry "BetterFrame A debug shell" {
  search --no-floppy --partuuid @PARTUUID_ROOT_A@ --set=root
  linux /vmlinuz root=PARTUUID=@PARTUUID_ROOT_A@ rw rauc.slot=A loglevel=7 systemd.show_status=1 plymouth.enable=0 init=/bin/bash
  initrd /initrd.img
}
GRUB
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/EFI/BOOT/grub.cfg
install -d -m 755 /boot/efi/EFI/debian /boot/grub
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/EFI/debian/grub.cfg
cp /boot/efi/EFI/betterframe/grub.cfg /boot/grub/grub.cfg
install -d -m 755 /boot/efi/boot/grub
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/grub.cfg
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/boot/grub/grub.cfg
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/EFI/BOOT/grub.cfg
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/EFI/debian/grub.cfg
cp /boot/efi/EFI/betterframe/grub.cfg /boot/grub/grub.cfg
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/grub.cfg
cp /boot/efi/EFI/betterframe/grub.cfg /boot/efi/boot/grub/grub.cfg
if [ ! -f /usr/lib/shim/shimx64.efi.signed ]; then
  echo "ERROR: shimx64.efi.signed is missing; cannot build a Secure Boot image" >&2
  exit 1
fi
if [ ! -f /usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed ]; then
  echo "ERROR: grubx64.efi.signed is missing; cannot build a Secure Boot image" >&2
  exit 1
fi
# Removable-media Secure Boot starts at EFI/BOOT/BOOTX64.EFI. That must be
# Microsoft-signed shim validates Debian's signed GRUB.
cp /usr/lib/shim/shimx64.efi.signed /boot/efi/EFI/BOOT/BOOTX64.EFI
cp /usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed /boot/efi/EFI/BOOT/grubx64.efi
cp /usr/lib/shim/shimx64.efi.signed /boot/efi/EFI/debian/shimx64.efi
cp /usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed /boot/efi/EFI/debian/grubx64.efi
cp /usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed /boot/efi/EFI/BOOT/grubx64-grub-signed.efi
cp /usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed /boot/efi/EFI/debian/grubx64-grub-signed.efi
if [ -f /usr/lib/shim/mmx64.efi.signed ]; then
  cp /usr/lib/shim/mmx64.efi.signed /boot/efi/EFI/BOOT/mmx64.efi
  cp /usr/lib/shim/mmx64.efi.signed /boot/efi/EFI/debian/mmx64.efi
fi

apt-get clean
/usr/local/sbin/randomize-image-users.sh bfadmin bfkiosk
rm -rf /var/lib/apt/lists/* /tmp/bf-files /tmp/betterframe-kiosk /tmp/install-betterframe-x86.sh
CHROOT

sed -i "s/@VERSION@/${VERSION}/g" "${WORK}/root/tmp/install-betterframe-x86.sh"
sed -i "s/@CHANNEL@/${IMAGE_CHANNEL}/g" "${WORK}/root/tmp/install-betterframe-x86.sh"
sed -i \
  -e "s/@PARTUUID_ROOT_A@/${PARTUUID_ROOT_A}/g" \
  -e "s/@PARTUUID_ROOT_B@/${PARTUUID_ROOT_B}/g" \
  "${WORK}/root/tmp/install-betterframe-x86.sh"
chmod +x "${WORK}/root/tmp/install-betterframe-x86.sh"
chroot "${WORK}/root" /tmp/install-betterframe-x86.sh

sync
umount "${WORK}/root/run" "${WORK}/root/sys" "${WORK}/root/proc" "${WORK}/root/dev/pts" "${WORK}/root/dev" "${WORK}/root/boot/efi"
umount "${WORK}/root"
echo "==> Cloning initial root slot A to B"
dd if="${LOOP}p2" of="${LOOP}p3" bs=16M conv=fsync status=none
tune2fs -L BF_ROOT_B "${LOOP}p3"
if [ -n "$ROOTFS_OUT" ]; then
  dd if="${LOOP}p2" of="$ROOTFS_OUT" bs=4M status=none
fi
if [ -n "$BOOTFS_OUT" ]; then
  dd if="${LOOP}p1" of="$BOOTFS_OUT" bs=4M status=none
fi
losetup -d "$LOOP"
LOOP=""

echo "==> Compressing x86 image"
xz -T0 -6 -c "$IMG" > "$OUT_IMG_XZ"
ls -lh "$OUT_IMG_XZ"
