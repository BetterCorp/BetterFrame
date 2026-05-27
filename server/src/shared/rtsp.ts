export interface RtspParts {
  host: string | null;
  port: number | null;
  path: string | null;
  username: string | null;
  password: string | null;
}

export function parseRtspUri(raw: string | null | undefined): RtspParts {
  if (!raw) {
    return { host: null, port: null, path: null, username: null, password: null };
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "rtsp:") {
      return { host: null, port: null, path: null, username: null, password: null };
    }
    let path = url.pathname || "/";
    if (url.search) path += url.search;
    return {
      host: url.hostname || null,
      port: url.port ? Number(url.port) : 554,
      path,
      username: url.username ? decodeURIComponent(url.username) : null,
      password: url.password ? decodeURIComponent(url.password) : null,
    };
  } catch {
    return { host: null, port: null, path: null, username: null, password: null };
  }
}

export function stripRtspCredentials(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "rtsp:") return raw;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export function buildRtspUri(
  raw: string | null | undefined,
  username?: string | null,
  password?: string | null,
): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "rtsp:") return raw;
    url.username = "";
    url.password = "";
    if (username) {
      url.username = username;
      url.password = password ?? "";
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function buildRtspUriFromParts(
  host: string,
  port: number,
  path: string,
): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const portSuffix = port === 554 ? "" : `:${String(port)}`;
  return `rtsp://${host}${portSuffix}${cleanPath}`;
}
