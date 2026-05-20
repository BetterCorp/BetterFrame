#!/bin/bash -e
# Host-side (runs outside chroot, before 01-run-chroot.sh). Stages every
# file from the sub-stage's files/ dir into the chroot at /tmp/bf-files
# so the chroot script can install them. Files dir is populated by CI
# (build.yml's "Stage files for pi-gen" step).
install -d "${ROOTFS_DIR}/tmp/bf-files"
cp -r "${BASE_DIR}/stage-betterframe-client/01-install-kiosk/files/." \
      "${ROOTFS_DIR}/tmp/bf-files/"
