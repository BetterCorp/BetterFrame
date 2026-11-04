#!/bin/sh
set -eu
# Do not migrate or query the target while its isolated restore is in progress.
if [ "${BF_EXPECT_CLONE:-false}" = "true" ]; then
  while [ ! -f /var/lib/betterframe/.bp-clone-complete ]; do
    echo "Waiting for the isolated Frame database clone to finish"
    sleep 10
  done
fi
chown node:node /home/bsb/sec-config.yaml
exec su node -s /bin/sh -c 'exec node /home/bsb/node_modules/@bsb/base/lib/cli.js'
