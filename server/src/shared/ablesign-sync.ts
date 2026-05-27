/**
 * AbleSign account sync — shared between startup background sync and route handlers.
 */
import * as ablesign from "./ablesign.js";
import type { Repository } from "./db/repository.js";
import type { SecretsApi } from "./secrets.js";

export async function syncAbleSignAccount(
  account: { id: string; name: string; api_key_encrypted: string; workspace_id?: string | null; screen_count?: number },
  repo: Repository,
  secrets: SecretsApi,
): Promise<{ synced: number }> {
  const apiKey = secrets.decryptString(account.api_key_encrypted, "ablesign-key");
  const opts: ablesign.ApiOpts = { apiKey, workspaceId: account.workspace_id || undefined };
  const result = await ablesign.listScreens(opts);

  for (const s of result.data) {
    await repo.upsertAbleSignScreen({
      account_id: account.id,
      ablesign_screen_id: String(s.id),
      title: s.title,
      online: !!s.heartbeatTime,
      last_heartbeat_at: s.heartbeatTime || undefined,
      orientation: s.orientation,
    });
  }

  await repo.updateAbleSignAccount(account.id, {
    screen_count: result.data.length,
    last_sync_at: new Date().toISOString(),
    last_sync_error: null,
  });

  return { synced: result.data.length };
}
