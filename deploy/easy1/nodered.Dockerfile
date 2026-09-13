FROM easypanel/betterframe/nodered:latest AS source
USER root
ADD --checksum=sha256:@SOURCE_SHA256@ https://codeload.github.com/BetterCorp/BetterFrame/tar.gz/@COMMIT@ /tmp/betterframe-source.tar.gz
RUN mkdir /tmp/betterframe-source && tar -xzf /tmp/betterframe-source.tar.gz --strip-components=1 -C /tmp/betterframe-source
RUN BF_NODERED_MANAGER_SECRET=0123456789abcdef0123456789abcdef BF_NODERED_MANAGER_SELF_TEST=1 node /tmp/betterframe-source/deploy/nodered-manager/manager.mjs

FROM easypanel/betterframe/nodered:latest
LABEL org.opencontainers.image.revision="@COMMIT@" org.opencontainers.image.version="@VERSION@"
COPY --from=source --chown=node-red:root /tmp/betterframe-source/nodered/ /usr/src/betterframe-nodes/
COPY --from=source --chown=node-red:root /tmp/betterframe-source/deploy/nodered-manager/manager.mjs /usr/src/betterframe-manager/manager.mjs
HEALTHCHECK --interval=20s --timeout=5s --start-period=90s --retries=5 CMD node -e "fetch('http://127.0.0.1:1880/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
