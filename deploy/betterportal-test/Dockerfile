# Render the three @...@ source placeholders before use as an inline Dockerfile.
FROM node:24-bookworm-slim AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:@SOURCE_SHA256@ https://codeload.github.com/BetterCorp/BetterFrame/tar.gz/@COMMIT@ /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /build
RUN npm ci --include=dev --workspace=server && npm run build && npm prune --omit=dev --workspace=server
RUN node --input-type=module -e "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); await require('argon2').hash('native-build-test');"

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gettext-base ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /home/bsb
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/server/package.json ./server/package.json
COPY --from=builder /build/server/bsb-plugin.json ./server/bsb-plugin.json
COPY --from=builder /build/server/lib ./server/lib
COPY --from=builder /build/sec-config.template.yaml ./sec-config.template.yaml
COPY --from=builder /build/deploy/docker/server-entrypoint.sh /usr/local/bin/bf-entrypoint.sh
COPY --from=builder /build/deploy/betterportal-test/start-bsb.sh ./entrypoint.sh
RUN chmod 755 /usr/local/bin/bf-entrypoint.sh /home/bsb/entrypoint.sh && echo '@VERSION@' > /home/bsb/.bf-version
ENV NODE_ENV=production APP_DIR=/home/bsb/server BSB_CONFIG_FILE=/home/bsb/sec-config.yaml BSB_WRITABLE_PATHS=/var/lib/betterframe BSB_PLUGIN_DIRS=""
ENTRYPOINT ["/usr/local/bin/bf-entrypoint.sh"]
CMD []
EXPOSE 18083
# Allow the isolated database restore to complete before health failures restart this test service.
HEALTHCHECK --interval=20s --timeout=5s --start-period=7200s --retries=5 CMD node -e "fetch('http://127.0.0.1:18083/.well-known/bp/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
LABEL org.opencontainers.image.revision="@COMMIT@" org.opencontainers.image.version="@VERSION@"
