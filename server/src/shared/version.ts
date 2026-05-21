export function serverVersion(): string {
  return (
    process.env.BF_SERVER_VERSION
    || process.env.BF_BUILD_VERSION
    || process.env.COOLIFY_GIT_COMMIT
    || process.env.SOURCE_COMMIT
    || "dev"
  );
}
