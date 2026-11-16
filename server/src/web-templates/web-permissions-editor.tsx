import { resolveWebPermissions, WEB_PERMISSION_KEYS, type WebPermissions } from "../shared/web-permissions.js";
const labels = {"audio": "Sound", "autoplay": "Automatic audio and video", "microphone": "Microphone", "camera": "Camera", "location": "Location", "notifications": "Notifications", "clipboard": "Clipboard", "device_info": "List media devices", "protected_media": "Protected media", "cross_site_storage": "Cross-site storage", "pointer_lock": "Pointer lock"};
export function WebPermissionsEditor({ config }: { config?: Partial<WebPermissions> }) {
  const permissions = resolveWebPermissions(config);
  return <fieldset class="card" style="box-shadow:none;border:1px solid #eee;margin:1rem 0;padding:1rem">
    <legend>Web permissions</legend><input type="hidden" name="web_permissions_present" value="1" />
    <p class="form-hint">Linux WebKit content uses these settings automatically, without permission dialogs. Hidden layouts are muted. Fullscreen, popup windows and dialogs are unavailable.</p>
    {WEB_PERMISSION_KEYS.map(key => <label style="display:block;margin:0.5rem 0"><input type="checkbox" name={`web_permission_${key}`} value="1" checked={permissions[key]} /> {labels[key]}</label>)}
    <p class="form-hint">Permissions apply while the block is on its configured website origin. Website storage may be cleared at any time. Media hardware and secure website access are still required.</p>
  </fieldset>;
}
