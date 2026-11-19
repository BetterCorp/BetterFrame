# Build with integrations/simplevms/build.sh against the recorder's extended host.
# Context: its output directory containing plugin/ and host/.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=0:0 plugin/ /app/plugins/BetterFrame/
COPY --chown=0:0 host/Shared.Models.dll /app/Shared.Models.dll
COPY --chown=0:0 host/Server.Api.dll /app/Server.Api.dll
COPY --chown=0:0 host/wwwroot/ /app/wwwroot/
RUN chmod -R a+rX /app/plugins/BetterFrame /app/wwwroot && chmod a+r /app/Shared.Models.dll /app/Server.Api.dll
