#!/bin/bash -e
# Host-side (runs outside chroot, before 01-run-chroot.sh). Pi-gen sets
# cwd to the sub-stage directory and exposes ROOTFS_DIR. Bulk-copy this
# sub-stage's files/ into the chroot at /tmp/bf-files so 01-run-chroot.sh
# can install them. files/ is populated by CI (build.yml's "Stage files
# for pi-gen" step).
SUB_STAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
install -d "${ROOTFS_DIR}/tmp/bf-files"
cp -r "${SUB_STAGE_DIR}/files/." "${ROOTFS_DIR}/tmp/bf-files/"
