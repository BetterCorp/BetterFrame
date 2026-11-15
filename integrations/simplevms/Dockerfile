# Build the plugin first using the same SimpleVMS source/API as the recorder.
# Context: a directory containing the dotnet publish output under plugin/.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=0:0 plugin/ /app/plugins/BetterFrame/
RUN chmod -R a+rX /app/plugins/BetterFrame
