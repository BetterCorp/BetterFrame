/**
 * Cloud camera integration types.
 *
 * Each vendor (Hik-Connect, Dahua DMSS, Tuya, Uniview, TP-Link) implements
 * the CloudCameraProvider interface. Accounts are stored per-tenant with
 * encrypted credentials. Multiple accounts per vendor per tenant supported.
 */

export interface CloudAccount {
  id: string; // UUID
  vendor: CloudVendor;
  name: string; // operator-chosen label, e.g. "Main office Hik-Connect"
  credentials_encrypted: string; // AES-256-GCM with server secret
  is_active: boolean;
  last_sync_at: string | null;
  last_sync_error: string | null;
  camera_count: number;
  created_at: string;
}

export type CloudVendor = "hikconnect" | "ezviz" | "dahua" | "tuya" | "uniview" | "tplink" | "reolink" | "eagle_eye";

export const CLOUD_VENDORS: readonly CloudVendor[] = [
  "hikconnect", "ezviz", "dahua", "tuya", "uniview", "tplink", "reolink", "eagle_eye",
] as const;

export const VENDOR_LABELS: Record<CloudVendor, string> = {
  hikconnect: "Hik-Connect for Teams",
  ezviz: "EZVIZ (Hikvision Consumer)",
  dahua: "Dahua DMSS",
  tuya: "Tuya IoT",
  uniview: "Uniview Cloud",
  tplink: "TP-Link (Tapo/VIGI)",
  reolink: "Reolink",
  eagle_eye: "Eagle Eye Networks",
};

export type CloudStreamType = "rtsp" | "hls" | "rtmp" | null;

export interface CloudCamera {
  vendor_id: string;
  name: string;
  model: string | null;
  rtsp_url: string | null;
  relay_url: string | null;
  online: boolean;
  stream_type: CloudStreamType;
  extra: Record<string, unknown>;
}

/**
 * Interface each vendor module implements.
 */
export interface CloudCameraProvider {
  vendor: CloudVendor;

  /**
   * Validate credentials and return a session/token.
   * Called during account setup (admin enters creds → we test them).
   */
  testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }>;

  /**
   * List all cameras on the account.
   */
  listCameras(creds: Record<string, string>): Promise<CloudCamera[]>;

  /**
   * Get an RTSP or streaming URL for a specific camera.
   * Some vendors require a per-session token for streaming.
   */
  getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null>;

  /**
   * What credential fields this vendor needs (for the admin form).
   * e.g. [{name: "username", label: "Email", type: "text"}, {name: "password", ...}]
   */
  credentialFields(): Array<{
    name: string;
    label: string;
    type: "text" | "password" | "email";
    required: boolean;
  }>;
}

/**
 * Registry of cloud camera providers.
 */
const providers = new Map<CloudVendor, CloudCameraProvider>();

export function registerProvider(provider: CloudCameraProvider): void {
  providers.set(provider.vendor, provider);
}

export function getProvider(vendor: CloudVendor): CloudCameraProvider | undefined {
  return providers.get(vendor);
}

export function listProviders(): CloudCameraProvider[] {
  return [...providers.values()];
}
