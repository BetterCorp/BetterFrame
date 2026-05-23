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

export type CloudVendor = "hikconnect" | "dahua" | "tuya" | "uniview" | "tplink";

export const CLOUD_VENDORS: readonly CloudVendor[] = [
  "hikconnect", "dahua", "tuya", "uniview", "tplink",
] as const;

export const VENDOR_LABELS: Record<CloudVendor, string> = {
  hikconnect: "Hik-Connect (Hikvision)",
  dahua: "Dahua DMSS",
  tuya: "Tuya IoT",
  uniview: "Uniview Cloud",
  tplink: "TP-Link (Tapo/VIGI)",
};

export interface CloudCamera {
  /** Vendor-specific unique ID for this camera. */
  vendor_id: string;
  name: string;
  model: string | null;
  /** Direct RTSP URL if the vendor provides one. */
  rtsp_url: string | null;
  /** Vendor-specific relay/streaming URL (e.g. HLS, RTMP). */
  relay_url: string | null;
  online: boolean;
  /** Additional vendor-specific metadata. */
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
