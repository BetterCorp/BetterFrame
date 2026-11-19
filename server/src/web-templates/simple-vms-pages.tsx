import { Layout, LocalTime } from "./layout.js";
import type { Kiosk } from "../shared/types.js";
import type { SimpleVmsSummary } from "../shared/simple-vms.js";
import type { SimpleVmsPairRequest } from "../shared/simple-vms-pairing.js";

function SyncStatus({ source: s }: { source: SimpleVmsSummary }) {
  return <span>{!s.enabled ? "Disabled" : !s.auto_sync ? "Auto-sync paused" : s.last_sync_at ? <>Last sync: <LocalTime value={String(s.last_sync_at)} /></> : "Waiting for initial camera sync"} · {s.camera_count} cameras</span>;
}
export function SimpleVmsHandoffPage(props: { location: string; destination?: string }) {
  const destination = props.destination ?? "BetterFrame";
  return <Layout title={`Continue to ${destination}`} minimal>
    <meta http-equiv="refresh" content={`0;url=${props.location}`} />
    <p><a href={props.location}>Continue to {destination}</a></p>
  </Layout>;
}

export function SimpleVmsInstancesPage(props: { user?: string; sources: SimpleVmsSummary[]; frameUrl: string }) {
  return <Layout title="SimpleVMS instances" user={props.user} activeNav="simplevms">
    <h1>SimpleVMS instances</h1>
    <p>In SimpleVMS, open the BetterFrame plugin, enter <code>{props.frameUrl}</code> and choose <strong>Pair with BetterFrame</strong>. Approve the connection here; credentials and camera sync are set up automatically.</p>
    <p>Pair one recorder for each property or region, then select its kiosks in kiosk settings.</p>
    {props.sources.length ? <table><thead><tr><th>Instance</th><th>Status</th><th></th></tr></thead><tbody>{props.sources.map(s => <tr>
      <td><a href={`/admin/simplevms/${s.id}`}>{s.name}</a></td><td><SyncStatus source={s} /></td><td><a href={`/admin/simplevms/${s.id}`}>Manage</a></td>
    </tr>)}</tbody></table> : <p>No SimpleVMS instances paired yet.</p>}
  </Layout>;
}

export function SimpleVmsPairPage(props: { user?: string; request: SimpleVmsPairRequest; tenantName: string; reconnect: boolean; networkConfirmation?: { media: string; browser: string } }) {
  return <Layout title="Pair SimpleVMS" user={props.user} activeNav="simplevms">
    <h1>Pair {props.request.name} with BetterFrame</h1>
    <p>Approve this recorder for <strong>{props.tenantName}</strong>, then confirm the connection in SimpleVMS. Pairing finishes only after you confirm on both sides. Cameras and display groups will then sync automatically.</p>
    <p>Return to SimpleVMS at <strong>{new URL(props.request.redirect_uri).origin}</strong>.</p>
    {props.reconnect ? <p>This recorder already exists in this tenant. Pairing again replaces its connection credentials and preserves its cameras, layouts and kiosk links.</p> : ""}
    <form method="post" action="/admin/simplevms/pair">
      {Object.entries(props.request).filter(([key]) => !props.networkConfirmation || !["external_address", "external_http_address"].includes(key)).map(([key, value]) => <input type="hidden" name={key} value={value} />)}
      {props.networkConfirmation ? <fieldset><legend>Confirm network media addresses</legend>
        <p>The recorder's listener port or protocol changed. Confirm or update the addresses other kiosks use. A reverse proxy may use a different port.</p>
        <div class="form-group"><label>Media address for other kiosks</label><input class="form-input" name="external_address" value={props.networkConfirmation.media} /></div>
        <div class="form-group"><label>HTTPS browser media address for other kiosks</label><input class="form-input" name="external_http_address" value={props.networkConfirmation.browser} /></div>
      </fieldset> : ""}
      <button class="btn btn-primary" type="submit">{props.reconnect ? "Reconnect SimpleVMS" : "Pair SimpleVMS"}</button>
      <a class="btn" href="/admin/simplevms">Cancel</a>
    </form>
  </Layout>;
}

export function SimpleVmsInstancePage(props: { user?: string; source: SimpleVmsSummary; kiosks: Kiosk[] }) {
  const s = props.source;
  return <Layout title={s.name} user={props.user} activeNav="simplevms">
    <p><a href="/admin/simplevms">SimpleVMS instances</a></p><h1>{s.name}</h1>
    <p><SyncStatus source={s} /></p>
    {!s.last_sync_at ? <p>The SimpleVMS plugin sends the first catalog immediately after pairing. If it has not arrived, check that the plugin is running and can reach this BF server.</p> : ""}
    <p>Manage cameras, recording and display groups in SimpleVMS. BetterFrame receives changes automatically.</p>
    <h2>Kiosks</h2>
    {props.kiosks.length ? <ul>{props.kiosks.map(k => <li><a href={`/admin/kiosks/${k.id}#simplevms`}>{k.name}</a></li>)}</ul> : <p>No kiosks linked yet.</p>}
    <p><a href="/admin/kiosks">Open kiosk settings to connect a kiosk</a></p>
    <form method="post" action={`/admin/simplevms/${s.id}`}>
      <label style="display:block"><input type="checkbox" name="enabled" value="1" checked={s.enabled} /> Enable connection</label>
      <label style="display:block"><input type="checkbox" name="auto_sync" value="1" checked={s.auto_sync} /> Auto-sync cameras and group layouts</label>
      <details style="margin:1rem 0"><summary>Media addresses</summary>
        <p>Use recorder addresses reachable from the kiosks. Local addresses apply when SimpleVMS runs on that kiosk.</p>
        <div class="form-group"><label>Local media address</label><input class="form-input" name="local_address" required value={s.local_address} /></div>
        <div class="form-group"><label>Media address for other kiosks</label><input class="form-input" name="external_address" value={s.external_address ?? ""} /></div>
        <div class="form-group"><label>Local browser media address</label><input class="form-input" name="local_http_address" value={s.local_http_address ?? ""} /></div>
        <div class="form-group"><label>HTTPS browser media address for other kiosks</label><input class="form-input" name="external_http_address" value={s.external_http_address ?? ""} /></div>
      </details>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>
    <form method="post" action={`/admin/simplevms/${s.id}/remove`} style="margin-top:2rem">
      <p>Removing this instance removes its imported BF cameras and generated layouts. Custom layouts and native recordings remain.</p>
      <button class="btn btn-danger" type="submit" {...{ onclick: "return confirm('Remove this SimpleVMS instance and its imported BF cameras and generated layouts?')" }}>Remove instance</button>
    </form>
  </Layout>;
}

export function SimpleVmsKioskCard(props: { kiosk: Kiosk; sources: SimpleVmsSummary[] }) {
  const connected = props.sources.filter(s => s.connected);
  const available = props.sources.filter(s => s.enabled && !s.connected);
  return <div class="card" id="simplevms" style="margin-bottom:1.5rem">
    <h2>SimpleVMS</h2><p>Choose the paired recorders this kiosk can access. Their camera-group layouts are added automatically.</p>
    {connected.map(s => <div style="display:flex;gap:1rem;align-items:center;margin:.5rem 0">
      <span><a href={`/admin/simplevms/${s.id}`}>{s.name}</a> · {s.use_local_address ? "On this kiosk" : "Network recorder"}</span>
      <form method="post" action={`/admin/kiosks/${props.kiosk.id}/simple-vms/unlink`}><input type="hidden" name="source_id" value={s.id} /><button class="btn btn-sm" type="submit">Disconnect</button></form>
    </div>)}
    {available.length ? <form method="post" action={`/admin/kiosks/${props.kiosk.id}/simple-vms/link`}>
      <div class="form-group"><label for="simple-vms-source">SimpleVMS instance</label><select id="simple-vms-source" name="source_id" class="form-input" required>
        <option value="">Select a paired instance</option>{available.map(s => <option value={s.id}>{s.name}</option>)}
      </select></div>
      {!props.kiosk.capabilities.includes("android-viewer") ? <label style="display:block;margin-bottom:1rem"><input type="checkbox" name="use_local_address" value="1" /> SimpleVMS runs on this kiosk</label> : ""}
      <button class="btn btn-primary" type="submit">Connect instance</button>
    </form> : <p>{connected.length ? "All available instances are connected." : "Pair a recorder in SimpleVMS first."}</p>}
    <p><a href="/admin/simplevms">Manage SimpleVMS instances</a></p>
  </div>;
}

export function SimpleVmsManagedPage(props: { user?: string; name: string; kind: string; items: Array<{ id: string; name: string; href?: string }>; availability: string[] }) {
  return <Layout title={props.name} user={props.user} activeNav="cameras">
    <h1>{props.name}</h1><p>{props.kind} · Managed by SimpleVMS. Change its configuration in SimpleVMS.</p>
    <p>Available on: {props.availability.join(", ") || "No enabled kiosk connection"}</p>
    <ul>{props.items.map(item => <li>{item.href ? <a href={item.href}>{item.name}</a> : item.name}</li>)}</ul>
  </Layout>;
}
