import * as av from "anyvali";
export const WEB_PERMISSION_KEYS = ["audio", "autoplay", "microphone", "camera", "location", "notifications", "clipboard", "device_info", "protected_media", "cross_site_storage", "pointer_lock"] as const;
export type WebPermissionKey = typeof WEB_PERMISSION_KEYS[number];
export type WebPermissions = Record<WebPermissionKey, boolean>;
export const DEFAULT_WEB_PERMISSIONS: WebPermissions = Object.fromEntries(WEB_PERMISSION_KEYS.map(key => [key, key === "audio" || key === "autoplay"])) as WebPermissions;
export const webPermissionsSchema = av.object({
  audio: av.optional(av.bool()),
  autoplay: av.optional(av.bool()),
  microphone: av.optional(av.bool()),
  camera: av.optional(av.bool()),
  location: av.optional(av.bool()),
  notifications: av.optional(av.bool()),
  clipboard: av.optional(av.bool()),
  device_info: av.optional(av.bool()),
  protected_media: av.optional(av.bool()),
  cross_site_storage: av.optional(av.bool()),
  pointer_lock: av.optional(av.bool()),
}, { unknownKeys: "reject" });
export function resolveWebPermissions(raw?: Partial<WebPermissions> | null): WebPermissions {
  return Object.fromEntries(WEB_PERMISSION_KEYS.map(key => [key, typeof raw?.[key] === "boolean" ? raw[key] : DEFAULT_WEB_PERMISSIONS[key]])) as WebPermissions;
}
export function webPermissionsForm(body: Record<string, string | undefined>): WebPermissions {
  return Object.fromEntries(WEB_PERMISSION_KEYS.map(key => [key, body[`web_permission_${key}`] === "1"])) as WebPermissions;
}
