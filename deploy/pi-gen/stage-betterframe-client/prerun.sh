#!/bin/bash -e
# Standard pi-gen prerun: bring in the previous stage's rootfs if our
# working directory isn't already populated. Every pi-gen stage needs this.
if [ ! -d "${ROOTFS_DIR}" ]; then
    copy_previous
fi
