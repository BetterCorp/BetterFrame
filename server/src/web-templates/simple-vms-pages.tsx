import { Layout } from "./layout.js";
import type { Kiosk } from "../shared/types.js";
import type { SimpleVmsSource } from "../shared/simple-vms.js";

export function SimpleVmsSettingsPage(props: { user?: string; kiosk: Kiosk; kiosks: Kiosk[]; source?: SimpleVmsSource; linked: string[]; callback: string }) {
  const s = props.source;
  return <Layout title="SimpleVMS connection" user={props.user} activeNav="kiosks">
    <h1>SimpleVMS · {props.kiosk.name}</h1>
    <p>Manage cameras, recording and display groups in SimpleVMS. BetterFrame receives changes automatically.</p>
    <p>Last sync: {s?.last_sync_at ? String(s.last_sync_at) : "Waiting for SimpleVMS"} · Revision: {String(s?.revision ?? 0)}</p>
    {s ? <p>Plugin callback URL: <code>{props.callback}</code></p> : ""}
    <form method="post" action={`/admin/kiosks/${props.kiosk.id}/simple-vms`}>
      <label><input type="checkbox" name="enabled" value="1" checked={s?.enabled ?? true} /> Enable SimpleVMS connection</label><br />
      <label><input type="checkbox" name="auto_sync" value="1" checked={s?.auto_sync ?? true} /> Auto-sync cameras and group layouts</label>
      <div class="form-group"><label>SimpleVMS instance ID</label><input class="form-input" name="instance_id" required maxlength="128" readonly={!!s} value={s?.instance_id ?? ""} /><p class="form-hint">Use the instance ID shown in the BetterFrame plugin settings.</p></div>
      <div class="form-group"><label>Media address for this kiosk</label><input class="form-input" name="local_address" required value={s?.local_address ?? "rtsp://127.0.0.1:8554"} /></div>
      <div class="form-group"><label>External media address</label><input class="form-input" name="external_address" value={s?.external_address ?? ""} placeholder="rtsp://nvr.property.lan:8554" /><p class="form-hint">Required for linked kiosks. Use an address they can reach.</p></div>
      <div class="form-group"><label>Browser media address for this kiosk</label><input class="form-input" name="local_http_address" value={s?.local_http_address ?? "http://127.0.0.1:8555"} /></div>
      <div class="form-group"><label>External browser media address</label><input class="form-input" name="external_http_address" value={s?.external_http_address ?? ""} placeholder="https://nvr.property.lan:8555" /><p class="form-hint">Enables browser preview and recording export on linked kiosks.</p></div>
      <div class="form-group"><label>Viewer username</label><input class="form-input" name="viewer_username" required maxlength="128" value={s?.viewer_username ?? "betterframe"} /></div>
      <div class="form-group"><label>Viewer password</label><input class="form-input" type="password" name="viewer_password" required={!s} autocomplete="new-password" /><p class="form-hint">Separate from camera credentials. Leave blank to preserve the saved password.</p></div>
      <div class="form-group"><label>Integration token</label><input class="form-input" type="password" name="ingest_token" required={!s} minlength="32" maxlength="256" autocomplete="new-password" /><p class="form-hint">Configure the same token in the SimpleVMS plugin. Leave blank to preserve it.</p></div>
      <fieldset><legend>Linked kiosks</legend>{props.kiosks.filter(k => k.id !== props.kiosk.id && k.enabled).map(k =>
        <label style="display:block"><input type="checkbox" name={`linked_${k.id}`} value="1" checked={props.linked.includes(k.id)} /> {k.name}</label>)}</fieldset>
      <button class="btn btn-primary" type="submit">Save connection</button>
    </form>
    {s ? <form method="post" action={`/admin/kiosks/${props.kiosk.id}/simple-vms/remove`} style="margin-top:1rem">
      <p>Removing this connection deletes BF's imported cameras and generated layouts. Custom layouts remain. Cameras and recordings in SimpleVMS remain unchanged.</p>
      <button class="btn btn-danger" type="submit" {...{ onclick: "return confirm('Remove this SimpleVMS connection and its imported BF cameras and generated layouts?')" }}>Remove SimpleVMS connection</button>
    </form> : ""}
  </Layout>;
}

export function SimpleVmsManagedPage(props: { user?: string; name: string; kind: string; items: Array<{ id: string; name: string; href?: string }>; availability: string[] }) {
  return <Layout title={props.name} user={props.user} activeNav="cameras">
    <h1>{props.name}</h1><p>{props.kind} · Managed by SimpleVMS. Change its configuration in SimpleVMS.</p>
    <p>Available on: {props.availability.join(", ") || "No enabled kiosk connection"}</p>
    <ul>{props.items.map(item => <li>{item.href ? <a href={item.href}>{item.name}</a> : item.name}</li>)}</ul>
  </Layout>;
}
