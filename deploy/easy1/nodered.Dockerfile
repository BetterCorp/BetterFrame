FROM easypanel/betterframe/runtime-nodered-5b29a29:latest AS source
USER root
ADD --checksum=sha256:@SOURCE_SHA256@ https://codeload.github.com/BetterCorp/BetterFrame/tar.gz/@COMMIT@ /tmp/betterframe-source.tar.gz
RUN mkdir /tmp/betterframe-source && tar -xzf /tmp/betterframe-source.tar.gz --strip-components=1 -C /tmp/betterframe-source
WORKDIR /tmp/betterframe-source
RUN npm ci --omit=dev --workspace=nodered && npm ls --omit=dev --workspace=nodered
RUN BF_NODERED_MANAGER_SECRET=0123456789abcdef0123456789abcdef BF_NODERED_MANAGER_SELF_TEST=1 node /tmp/betterframe-source/deploy/nodered-manager/manager.mjs

FROM easypanel/betterframe/runtime-nodered-5b29a29:latest
USER root
LABEL org.opencontainers.image.revision="@COMMIT@" org.opencontainers.image.version="@VERSION@"
# Replace the previous application tree rather than merging obsolete files or
# dependencies. Keep npm's workspace layout so hoisted and nested dependencies,
# including the workspace self-link, resolve exactly as installed from the lock.
RUN rm -rf /usr/src/betterframe-nodes /usr/src/betterframe-release
COPY --from=source --chown=node-red:root /tmp/betterframe-source/nodered/ /usr/src/betterframe-release/nodered/
COPY --from=source --chown=node-red:root /tmp/betterframe-source/node_modules/ /usr/src/betterframe-release/node_modules/
RUN ln -s /usr/src/betterframe-release/nodered /usr/src/betterframe-nodes
COPY --from=source --chown=node-red:root /tmp/betterframe-source/deploy/nodered-manager/manager.mjs /usr/src/betterframe-manager/manager.mjs
# Restore the application command instead of the snapshot retention process.
ENTRYPOINT ["node", "/usr/src/betterframe-manager/manager.mjs"]
CMD []
HEALTHCHECK --interval=20s --timeout=5s --start-period=90s --retries=5 CMD node -e "fetch('http://127.0.0.1:1880/readyz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
