import type { FirmwareChannel } from "./types.js";

/** Public release selection contains no tenant or device credentials. A saved
 * pin is authoritative: a missing/yanked pin must not fall through to latest. */
export async function selectPublicUpdate<T extends { yanked_at: string | null }>(
  query: URLSearchParams,
  latest: (channel: FirmwareChannel) => Promise<T | null>,
  pinned: (version: string) => Promise<T | null>,
): Promise<T | null> {
  const channel = query.get("channel") ?? "stable";
  if (!["stable", "beta", "dev"].includes(channel)) return null;
  const version = query.get("version");
  const release = version ? await pinned(version) : await latest(channel as FirmwareChannel);
  return release && !release.yanked_at ? release : null;
}
