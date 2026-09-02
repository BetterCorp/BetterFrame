/**
 * Wire schema for the managed-image device config: pushed from server to
 * kiosks running our pre-built Pi OS image. Kiosks pull on heartbeat
 * (response includes `pending_config` when server-side version exceeds
 * `applied_version`), apply via a privileged helper, echo `applied_version`
 * back on the next heartbeat.
 *
 * Wifi PSKs are encrypted with the cluster_key delivered at pairing time,
 * so the server can store ciphertext at rest and ship it to the kiosk
 * without a per-kiosk re-encryption step.
 */
import * as av from "anyvali";

export const NETWORK_MODES = ["dhcp", "static"] as const;

export const managedNetworkConfig = av.object(
  {
    mode: av.enum_(NETWORK_MODES),
    // Interface name as exposed by NetworkManager (e.g. "eth0", "wlan0").
    // Optional — helper defaults to the primary wired interface.
    interface: av.optional(av.string().minLength(1).maxLength(32)),
    // IPv4 CIDR for static mode. Ignored when mode=dhcp.
    ip_cidr: av.optional(av.string().pattern("^[0-9.]+/[0-9]+$")),
    gateway: av.optional(av.string().minLength(1).maxLength(64)),
    dns: av.optional(av.array(av.string().minLength(1).maxLength(64))),
    // 802.1Q VLAN id; helper creates a virtual interface when set.
    vlan_id: av.optional(av.int().min(1).max(4094)),
  },
  { unknownKeys: "reject" },
);

export const managedWifiConfig = av.object(
  {
    ssid: av.string().minLength(1).maxLength(64),
    // PSK encrypted with cluster_key via shared/secrets.encryptString.
    // Helper decrypts in-process before handing to NetworkManager.
    psk_ciphertext: av.string().minLength(1).maxLength(512),
  },
  { unknownKeys: "reject" },
);

export const managedConfig = av.object(
  {
    hostname: av.optional(av.string().minLength(1).maxLength(64)),
    // IANA tz name, e.g. "Etc/UTC", "America/New_York".
    timezone: av.optional(av.string().minLength(1).maxLength(64)),
    network: av.optional(managedNetworkConfig),
    wifi: av.optional(managedWifiConfig),
  },
  { unknownKeys: "reject" },
);

export type ManagedNetworkConfig = av.Infer<typeof managedNetworkConfig>;
export type ManagedWifiConfig = av.Infer<typeof managedWifiConfig>;
export type ManagedConfig = av.Infer<typeof managedConfig>;
