import type { AdminDeps } from "../../plugins/service-admin-http/index.js";
import { getProvider, type CloudVendor } from "../cloud-cameras/index.js";
export async function syncCloudAccount(accountId: string, deps: AdminDeps): Promise<void> {
  const account = await deps.repo.getCloudAccount(accountId);
  if (!account) return;

  const provider = getProvider(account.vendor as CloudVendor);
  if (!provider) {
    await deps.repo.updateCloudAccount(accountId, { last_sync_error: "unknown vendor" } as any);
    return;
  }

  let creds: Record<string, string>;
  try {
    creds = JSON.parse(deps.secrets.decryptString(account.credentials_encrypted, "cloud-creds"));
  } catch {
    await deps.repo.updateCloudAccount(accountId, { last_sync_error: "credential decrypt failed" } as any);
    return;
  }

  try {
    const cloudCameras = await provider.listCameras(creds);
    const vendorIds: string[] = [];

    for (const cam of cloudCameras) {
      vendorIds.push(cam.vendor_id);
      const streamUrl = cam.rtsp_url ?? cam.relay_url ?? null;
      await deps.repo.upsertCloudCamera({
        cloud_account_id: accountId,
        cloud_vendor_camera_id: cam.vendor_id,
        name: `${account.name}: ${cam.name}`,
        cloud_stream_url: streamUrl,
        cloud_stream_type: cam.stream_type ?? (streamUrl ? "rtsp" : null),
        enabled: cam.online,
      });
    }

    const removed = await deps.repo.deleteCloudCamerasNotIn(accountId, vendorIds);

    await deps.repo.updateCloudAccount(accountId, {
      camera_count: cloudCameras.length,
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
    } as any);
  } catch (err) {
    await deps.repo.updateCloudAccount(accountId, {
      last_sync_error: (err as Error).message,
      last_sync_at: new Date().toISOString(),
    } as any);
  }
}
