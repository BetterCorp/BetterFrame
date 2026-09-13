# BetterFrame @VERSION@; preserve the migrated BetterCorp runtime.
FROM easypanel/betterframe/runtime-server-5b29a29:latest AS builder
USER root
WORKDIR /tmp/betterframe-build
ADD --checksum=sha256:@SOURCE_SHA256@ https://codeload.github.com/BetterCorp/BetterFrame/tar.gz/@COMMIT@ /tmp/betterframe-source.tar.gz
RUN tar -xzf /tmp/betterframe-source.tar.gz --strip-components=1 -C /tmp/betterframe-build
RUN npm ci --include=dev --workspace=server && npm run build && npm prune --omit=dev --workspace=server
RUN node --input-type=module -e "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); await require('argon2').hash('build-native-compatibility-check'); require.resolve('pg'); require.resolve('h3');"

FROM easypanel/betterframe/runtime-server-5b29a29:latest
LABEL org.opencontainers.image.revision="@COMMIT@" org.opencontainers.image.version="@VERSION@"
RUN test -f /home/bsb/node_modules/betterframe/package.json && rm -rf /home/bsb/node_modules/betterframe/lib /home/bsb/node_modules/betterframe/node_modules
COPY --from=builder /tmp/betterframe-build/server/package.json /home/bsb/node_modules/betterframe/package.json
COPY --from=builder /tmp/betterframe-build/server/bsb-plugin.json /home/bsb/node_modules/betterframe/bsb-plugin.json
COPY --from=builder /tmp/betterframe-build/server/lib /home/bsb/node_modules/betterframe/lib
COPY --from=builder /tmp/betterframe-build/node_modules /home/bsb/node_modules/betterframe/node_modules
COPY --from=builder /tmp/betterframe-build/tsconfig.base.json /home/bsb/node_modules/betterframe/tsconfig.base.json
COPY --from=builder /tmp/betterframe-build/sec-config.template.yaml /home/bsb/sec-config.template.yaml
COPY --from=builder /tmp/betterframe-build/deploy/docker/server-entrypoint.sh /usr/local/bin/bf-entrypoint.sh
RUN chmod +x /usr/local/bin/bf-entrypoint.sh && echo '@VERSION@' > /home/bsb/.bf-version
# Snapshot containers sleep only to retain the base through Docker cleanup.
ENTRYPOINT ["/usr/local/bin/bf-entrypoint.sh"]
CMD []
HEALTHCHECK --interval=20s --timeout=5s --start-period=90s --retries=5 CMD node -e "fetch('http://127.0.0.1:18080/readyz',{signal:AbortSignal.timeout(4000)}).then(async r=>process.exit(r.ok&&(await r.json()).status==='ready'?0:1)).catch(()=>process.exit(1))"
