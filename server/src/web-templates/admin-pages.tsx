/**
 * Admin page templates: overview, cameras, kiosks, account, etc.
 */
import { js } from "jsx-htmx";
import { Layout } from "./layout.js";
import type {
  AuditEntry,
  Camera,
  Display,
  Entity,
  FirmwareRelease,
  FirmwareRollout,
  Kiosk,
  KioskGpioBinding,
  Label,
  Layout as LayoutType,
  LayoutCell,
  PairingCode,
  EventLog,
} from "../shared/types.js";

// ---- Overview ---------------------------------------------------------------

interface OverviewProps {
  user: string;
  cameraCount: number;
  kioskCount: number;
  onlineKioskCount: number;
  layoutCount: number;
  events: EventLog[];
}

export function OverviewPage(props: OverviewProps) {
  return (
    <Layout title="Overview" user={props.user} activeNav="overview">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Cameras</div>
          <div class="stat-value">{String(props.cameraCount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Kiosks</div>
          <div class="stat-value">{String(props.kioskCount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Kiosks Online</div>
          <div class="stat-value">{String(props.onlineKioskCount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Displays</div>
          <div class="stat-value">{String(props.layoutCount)}</div>
        </div>
      </div>

      <div class="section-header">
        <h2 class="section-title">Quick Links</h2>
      </div>
      <div class="stats-grid" style="margin-bottom:1.5rem">
        <a href="/admin/cameras/new" class="card" style="text-decoration:none; color:inherit">
          <strong>Add Camera</strong>
          <div style="color:#666; font-size:0.85rem">RTSP or ONVIF</div>
        </a>
        <a href="/admin/kiosks" class="card" style="text-decoration:none; color:inherit">
          <strong>Pair Kiosk</strong>
          <div style="color:#666; font-size:0.85rem">Enter pairing code</div>
        </a>
        <a href="/nrdp/" class="card" style="text-decoration:none; color:inherit">
          <strong>Rule Engine</strong>
          <div style="color:#666; font-size:0.85rem">Node-RED dashboard</div>
        </a>
      </div>

      <div class="section-header">
        <h2 class="section-title">Recent Events</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Topic</th>
              <th>Source</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {props.events.length === 0 ? (
              <tr><td colspan="4" style="text-align:center; color:#999; padding:2rem">No events yet</td></tr>
            ) : (
              props.events.map((ev) => (
                <tr>
                  <td style="white-space:nowrap; font-size:0.8rem">{formatTime(ev.received_at)}</td>
                  <td>{ev.topic}</td>
                  <td><span class="badge badge-gray">{ev.source_type}</span></td>
                  <td style="font-size:0.8rem; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
                    {JSON.stringify(ev.payload)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Cameras ----------------------------------------------------------------

interface CamerasProps {
  user: string;
  cameras: Camera[];
  streamCounts: Map<number, number>;
}

export function CamerasPage(props: CamerasProps) {
  return (
    <Layout title="Cameras" user={props.user} activeNav="cameras">
      <div class="section-header">
        <h2 class="section-title">All Cameras</h2>
        <a href="/admin/cameras/new" class="btn btn-primary">Add Camera</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Streams</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {props.cameras.length === 0 ? (
              <tr><td colspan="4" style="text-align:center; color:#999; padding:2rem">No cameras configured</td></tr>
            ) : (
              props.cameras.map((cam) => (
                <tr>
                  <td><a href={`/admin/cameras/${cam.id}`}><strong>{cam.name}</strong></a></td>
                  <td><span class="badge badge-blue">{cam.type.toUpperCase()}</span></td>
                  <td>{String(props.streamCounts.get(cam.id) ?? 0)}</td>
                  <td>
                    {cam.enabled
                      ? <span class="badge badge-green">Enabled</span>
                      : <span class="badge badge-gray">Disabled</span>
                    }
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Camera New -------------------------------------------------------------

interface CameraNewProps {
  user: string;
  error?: string;
  values?: Record<string, string>;
}

export function CameraNewPage(props: CameraNewProps) {
  const v = props.values ?? {};
  return (
    <Layout
      title="Add Camera"
      user={props.user}
      activeNav="cameras"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <div style="max-width:600px">
        <div style="margin-bottom:1rem">
          <a href="/admin/cameras/discover" class="btn btn-ghost">Discover via ONVIF &rarr;</a>
        </div>
        <form method="post" action="/admin/cameras/new">
          <input type="hidden" name="type" value="rtsp" />
          <div class="form-group">
            <label for="name">Camera Name</label>
            <input
              id="name"
              name="name"
              type="text"
              class="form-input"
              required
              maxlength="128"
              value={v["name"] ?? ""}
            />
          </div>

          <div class="form-group">
            <label for="rtsp_host">Host</label>
            <input id="rtsp_host" name="rtsp_host" type="text" class="form-input" placeholder="192.168.1.100" value={v["rtsp_host"] ?? ""} />
          </div>
          <div style="display:grid; grid-template-columns:1fr 2fr; gap:0.75rem">
            <div class="form-group">
              <label for="rtsp_port">Port</label>
              <input id="rtsp_port" name="rtsp_port" type="number" class="form-input" value={v["rtsp_port"] ?? "554"} />
            </div>
            <div class="form-group">
              <label for="rtsp_path">Path</label>
              <input id="rtsp_path" name="rtsp_path" type="text" class="form-input" placeholder="/Streaming/Channels/101" value={v["rtsp_path"] ?? ""} />
            </div>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem">
            <div class="form-group">
              <label for="rtsp_username">Username</label>
              <input id="rtsp_username" name="rtsp_username" type="text" class="form-input" value={v["rtsp_username"] ?? ""} />
            </div>
            <div class="form-group">
              <label for="rtsp_password">Password</label>
              <input id="rtsp_password" name="rtsp_password" type="password" class="form-input" value={v["rtsp_password"] ?? ""} />
            </div>
          </div>

          <button type="submit" class="btn btn-primary">Add Camera</button>
          <a href="/admin/cameras" class="btn btn-ghost" style="margin-left:0.5rem">Cancel</a>
        </form>
      </div>
    </Layout>
  );
}

// ---- Camera ONVIF Discovery ------------------------------------------------

interface CameraDiscoverProps {
  user: string;
  kiosks: Kiosk[];
  error?: string;
  values?: Record<string, string>;
}

export function CameraDiscoverPage(props: CameraDiscoverProps) {
  const v = props.values ?? {};
  return (
    <Layout
      title="Discover ONVIF Cameras"
      user={props.user}
      activeNav="cameras"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <div style="max-width:600px">
        <p style="color:#666; margin-bottom:1rem">
          Connect to an ONVIF camera or NVR by host and credentials. Profiles
          from the same video source are imported as streams on one camera.
        </p>
        <form method="post" action="/admin/cameras/discover" class="card">
          <div class="form-group">
            <label for="host">Host</label>
            <input id="host" name="host" type="text" class="form-input" placeholder="192.168.1.100" required value={v["host"] ?? ""} />
          </div>
          <div class="form-group">
            <label for="port">Port</label>
            <input id="port" name="port" type="number" class="form-input" value={v["port"] ?? "80"} />
          </div>
          <div class="form-group">
            <label for="discovery_runner">Run discovery from</label>
            <select id="discovery_runner" name="discovery_runner" class="form-input">
              <option value="server" selected={(v["discovery_runner"] ?? "server") === "server"}>Server</option>
              {props.kiosks.map((k) => (
                <option
                  value={`kiosk:${String(k.id)}`}
                  selected={v["discovery_runner"] === `kiosk:${String(k.id)}`}
                >
                  {k.name}{k.local_last_ip ? ` (${k.local_last_ip})` : ""}
                </option>
              )).join("")}
            </select>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem">
            <div class="form-group">
              <label for="username">Username</label>
              <input id="username" name="username" type="text" class="form-input" value={v["username"] ?? ""} />
            </div>
            <div class="form-group">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" class="form-input" value={v["password"] ?? ""} />
            </div>
          </div>
          <button type="submit" class="btn btn-primary">Discover</button>
          <a href="/admin/cameras/new" class="btn btn-ghost" style="margin-left:0.5rem">Cancel</a>
        </form>
      </div>
    </Layout>
  );
}

interface DiscoveredProfileRow {
  profile_name: string;
  profile_token: string;
  source_token: string | null;
  encoding: string | null;
  width: number | null;
  height: number | null;
  framerate: number | null;
  stream_uri: string;
  snapshot_uri: string | null;
  role: "main" | "sub" | "other";
}

interface DiscoveredCameraRow {
  name: string;
  source_token: string | null;
  profiles: DiscoveredProfileRow[];
}

interface CameraDiscoverResultsProps {
  user: string;
  host: string;
  username: string;
  password: string;
  cameras: DiscoveredCameraRow[];
  error?: string;
  success?: string;
}

function discoverResultsScript(rootId: string): string {
  return (
    `(function(){` +
    `var root=document.getElementById('${rootId}');if(!root)return;` +
    `var checks=function(){return Array.prototype.slice.call(root.querySelectorAll('input[name="selected"]'));};` +
    `root.querySelector('[data-action="check-all"]')?.addEventListener('click',function(){checks().forEach(function(c){c.checked=true;});});` +
    `root.querySelector('[data-action="uncheck-all"]')?.addEventListener('click',function(){checks().forEach(function(c){c.checked=false;});});` +
    `root.querySelector('[data-view="list"]')?.addEventListener('click',function(){root.dataset.view='list';});` +
    `root.querySelector('[data-view="cards"]')?.addEventListener('click',function(){root.dataset.view='cards';});` +
    `})()`
  );
}

const DISCOVER_RESULTS_CSS = `
#discover-results-root[data-view="cards"] .discover-results { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
#discover-results-root[data-view="list"] .discover-camera-card { margin-bottom: 1rem; }
#discover-results-root[data-view="list"] .discover-snaps { display: none; }
.discover-camera-card { margin-bottom: 1rem; }
.discover-snaps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; margin-bottom: 0.75rem; }
.discover-snap { position: relative; min-height: 150px; background: #111827; border-radius: 4px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.discover-snap img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; }
.discover-snap-label { position: absolute; left: 6px; top: 6px; background: rgba(17, 24, 39, 0.8); color: #fff; border-radius: 3px; padding: 2px 5px; font-size: 0.7rem; text-transform: uppercase; z-index: 1; }
.discover-snap-empty { color: #d1d5db; font-size: 0.8rem; }
`;

function CameraDiscoverResultsPageLegacy(props: {
  user: string;
  host: string;
  profiles: DiscoveredProfileRow[];
  error?: string;
  success?: string;
}) {
  return (
    <Layout
      title="ONVIF Cameras"
      user={props.user}
      activeNav="cameras"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <p style="color:#666; margin-bottom:1rem">
        Video sources reported by <strong>{props.host}</strong>. Each source imports
        as one camera with its profiles saved as streams.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Encoding</th>
              <th>Resolution</th>
              <th>FPS</th>
              <th>Stream URI</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {props.profiles.length === 0 ? (
              <tr><td colspan="6" style="text-align:center; color:#999; padding:2rem">No profiles returned</td></tr>
            ) : (
              props.profiles.map((p) => (
                <tr>
                  <td><strong>{p.profile_name}</strong></td>
                  <td>{p.encoding ? <span class="badge badge-blue">{p.encoding}</span> : "—"}</td>
                  <td>{p.width && p.height ? `${String(p.width)}x${String(p.height)}` : "—"}</td>
                  <td>{p.framerate != null ? String(p.framerate) : "—"}</td>
                  <td style="font-size:0.75rem; word-break:break-all; max-width:300px">{p.stream_uri}</td>
                  <td>
                    <form method="post" action="/admin/cameras/discover/add" style="display:inline">
                      <input type="hidden" name="name" value={`${props.host}: ${p.profile_name}`} />
                      <input type="hidden" name="rtsp_url" value={p.stream_uri} />
                      <input type="hidden" name="encoding" value={p.encoding ?? ""} />
                      <input type="hidden" name="width" value={String(p.width ?? "")} />
                      <input type="hidden" name="height" value={String(p.height ?? "")} />
                      <input type="hidden" name="framerate" value={String(p.framerate ?? "")} />
                      <input type="hidden" name="profile_token" value={p.profile_token} />
                      <button type="submit" class="btn btn-sm btn-primary">Add</button>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style="margin-top:1rem">
        <a href="/admin/cameras/discover" class="btn btn-ghost">Discover Another</a>
        <a href="/admin/cameras" class="btn btn-ghost" style="margin-left:0.5rem">Back to Cameras</a>
      </div>
    </Layout>
  );
}

export function CameraDiscoverResultsPage(props: CameraDiscoverResultsProps) {
  return (
    <Layout
      title="ONVIF Cameras"
      user={props.user}
      activeNav="cameras"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <style>{DISCOVER_RESULTS_CSS}</style>
      <div id="discover-results-root" data-view="list">
        <p style="color:#666; margin-bottom:1rem">
          Video sources reported by <strong>{props.host}</strong>. Each source imports
          as one camera with its profiles saved as streams.
        </p>
        {props.cameras.length === 0 ? (
          <div class="card" style="text-align:center; color:#999; padding:2rem">No profiles returned</div>
        ) : (
          <form method="post" action="/admin/cameras/discover/add">
            <input type="hidden" name="username" value={props.username} />
            <input type="hidden" name="password" value={props.password} />
            <div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:1rem; flex-wrap:wrap">
              <button type="button" class="btn btn-ghost" data-action="check-all">Check all</button>
              <button type="button" class="btn btn-ghost" data-action="uncheck-all">Uncheck all</button>
              <button type="button" class="btn btn-ghost" data-view="list">List</button>
              <button type="button" class="btn btn-ghost" data-view="cards">Cards</button>
              <button type="submit" class="btn btn-primary">Add selected</button>
            </div>
            <div class="discover-results">
              {props.cameras.map((cam, idx) => {
                const main = cam.profiles.find((p) => p.role === "main") ?? cam.profiles[0] ?? null;
                const sub = cam.profiles.find((p) => p.role === "sub") ?? null;
                return (
                  <div class="card discover-camera-card">
                    <input type="hidden" name={`camera_${String(idx)}_name`} value={cam.name} />
                    <input type="hidden" name={`camera_${String(idx)}_streams_json`} value={JSON.stringify(cam.profiles)} />
                    <div class="section-header" style="margin-bottom:0.75rem">
                      <label style="display:flex; gap:0.5rem; align-items:center">
                        <input type="checkbox" name="selected" value={String(idx)} checked />
                        <span>
                          <strong>{cam.name}</strong>
                          {cam.source_token ? <span style="color:#666; font-size:0.8rem"> Source: {cam.source_token}</span> : ""}
                        </span>
                      </label>
                    </div>
                    <div class="discover-snaps">
                      {[main, sub].filter(Boolean).map((p) => (
                        <div class="discover-snap">
                          <div class="discover-snap-label">{p!.role}</div>
                          {p!.snapshot_uri
                            ? <img src={p!.snapshot_uri} loading="lazy" />
                            : <div class="discover-snap-empty">No snapshot</div>}
                        </div>
                      ))}
                    </div>
                    <div class="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Role</th>
                            <th>Profile</th>
                            <th>Encoding</th>
                            <th>Resolution</th>
                            <th>FPS</th>
                            <th>Stream URI</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cam.profiles.map((p) => (
                            <tr>
                              <td><span class="badge badge-gray">{p.role}</span></td>
                              <td><strong>{p.profile_name}</strong></td>
                              <td>{p.encoding ? <span class="badge badge-blue">{p.encoding}</span> : "-"}</td>
                              <td>{p.width && p.height ? `${String(p.width)}x${String(p.height)}` : "-"}</td>
                              <td>{p.framerate != null ? String(p.framerate) : "-"}</td>
                              <td style="font-size:0.75rem; word-break:break-all; max-width:300px">{p.stream_uri}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              }).join("")}
            </div>
          </form>
        )}
      </div>
      <script>{js(discoverResultsScript("discover-results-root"))}</script>
      <div style="margin-top:1rem">
        <a href="/admin/cameras/discover" class="btn btn-ghost">Discover Another</a>
        <a href="/admin/cameras" class="btn btn-ghost" style="margin-left:0.5rem">Back to Cameras</a>
      </div>
    </Layout>
  );
}

// ---- Entities ---------------------------------------------------------------

interface EntitiesPageProps {
  user: string;
  entities: Entity[];
}

function entityBadge(type: string) {
  const cls =
    type === "camera" ? "badge-blue" :
    type === "web" ? "badge-green" :
    type === "dashboard" ? "badge-blue" :
    "badge-gray";
  return <span class={`badge ${cls}`}>{type}</span>;
}

function entityDetail(e: Entity): string {
  if (e.type === "camera") return e.camera_id ? `cam #${String(e.camera_id)}` : "—";
  if (e.type === "web") return e.web_url ?? "—";
  if (e.type === "html") return e.html_content ? `${e.html_content.slice(0, 80)}…` : "—";
  if (e.type === "dashboard") return e.dashboard_id ? `/dash/${e.dashboard_id}` : "—";
  return "—";
}

export function EntitiesPage(props: EntitiesPageProps) {
  const dashboards = props.entities.filter((e) => e.type === "dashboard");
  const others = props.entities.filter((e) => e.type !== "dashboard");
  return (
    <Layout title="Entities" user={props.user} activeNav="entities">
      <div class="section-header">
        <h2 class="section-title">All Entities</h2>
        <div style="display:flex; gap:0.5rem">
          <form method="post" action="/admin/entities/sync-dashboards" style="display:inline">
            <button type="submit" class="btn btn-ghost">Sync Dashboards</button>
          </form>
          <a href="/admin/entities/new" class="btn btn-primary">New Entity</a>
        </div>
      </div>
      <p style="color:#666; margin-bottom:1.25rem">
        Entities are reusable content blocks (a camera reference, an HTML
        snippet, a web page, or a Node-RED dashboard tab). Bind one entity to
        any number of layout cells — edit the entity once and every cell
        updates.
      </p>
      <div class="table-wrap" style="margin-bottom:1.5rem">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {others.length === 0 ? (
              <tr><td colspan="3" style="text-align:center; color:#999; padding:2rem">No entities yet</td></tr>
            ) : (
              others.map((e) => (
                <tr>
                  <td><a href={`/admin/entities/${e.id}`}><strong>{e.name}</strong></a></td>
                  <td>{entityBadge(e.type)}</td>
                  <td style="color:#666; font-size:0.85rem">{entityDetail(e)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div class="section-header">
        <h2 class="section-title">Dashboards (Node-RED)</h2>
      </div>
      <p style="color:#666; margin-bottom:1rem; font-size:0.85rem">
        Auto-synced from Node-RED. Press <b>Sync Dashboards</b> after adding or
        renaming tabs in Node-RED. Editing a dashboard happens in the Node-RED
        editor.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Tab ID</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {dashboards.length === 0 ? (
              <tr><td colspan="3" style="text-align:center; color:#999; padding:2rem">No dashboards synced yet — press Sync.</td></tr>
            ) : (
              dashboards.map((e) => (
                <tr>
                  <td><a href={`/admin/entities/${e.id}`}><strong>{e.name}</strong></a></td>
                  <td style="font-family:monospace; font-size:0.8rem; color:#666">{e.dashboard_id ?? "—"}</td>
                  <td style="color:#666; font-size:0.85rem">{e.dashboard_id ? `/dash/${e.dashboard_id}` : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

interface EntityNewPageProps {
  user: string;
  cameras: Camera[];
  error?: string;
  values?: Record<string, string>;
}

function entityFormScript(rootId: string): string {
  // Show/hide type-specific fieldsets when the type select changes.
  return (
    `(function(){` +
    `var root=document.getElementById('${rootId}');` +
    `if(!root)return;` +
    `var sel=root.querySelector('select[name="type"]');` +
    `var cf=root.querySelector('.ent-fields-camera');` +
    `var wf=root.querySelector('.ent-fields-web');` +
    `var hf=root.querySelector('.ent-fields-html');` +
    `function t(){var v=sel?sel.value:"html";` +
    `if(cf)cf.style.display=v==='camera'?'block':'none';` +
    `if(wf)wf.style.display=v==='web'?'block':'none';` +
    `if(hf)hf.style.display=v==='html'?'block':'none';}` +
    `if(sel)sel.addEventListener('change',t);t();})()`
  );
}

export function EntityNewPage(props: EntityNewPageProps) {
  const v = props.values ?? {};
  const selType = v["type"] ?? "html";
  return (
    <Layout
      title="New Entity"
      user={props.user}
      activeNav="entities"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <div id="entity-new-root" style="max-width:600px">
        <form method="post" action="/admin/entities/new" class="card">
          <div class="form-group">
            <label for="name">Name</label>
            <input id="name" name="name" type="text" class="form-input" required maxlength="128" value={v["name"] ?? ""} />
          </div>

          <div class="form-group">
            <label for="type">Type</label>
            <select id="type" name="type" class="form-input">
              <option value="html" selected={selType === "html"}>HTML snippet</option>
              <option value="web" selected={selType === "web"}>Web URL</option>
              <option value="camera" selected={selType === "camera"}>Camera reference</option>
            </select>
          </div>

          <div class="form-group">
            <label for="description">Description (optional)</label>
            <input id="description" name="description" type="text" class="form-input" value={v["description"] ?? ""} />
          </div>

          <div class="ent-fields-camera" style={selType === "camera" ? "" : "display:none"}>
            <div class="form-group">
              <label for="camera_id">Camera</label>
              <select id="camera_id" name="camera_id" class="form-input">
                <option value="">-- Select --</option>
                {props.cameras.map((cam) => (
                  <option value={String(cam.id)} selected={v["camera_id"] === String(cam.id)}>{cam.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div class="ent-fields-web" style={selType === "web" ? "" : "display:none"}>
            <div class="form-group">
              <label for="web_url">URL</label>
              <input id="web_url" name="web_url" type="url" class="form-input" placeholder="https://example.com" value={v["web_url"] ?? ""} />
            </div>
          </div>

          <div class="ent-fields-html" style={selType === "html" ? "" : "display:none"}>
            <div class="form-group">
              <label for="html_content">HTML</label>
              <textarea id="html_content" name="html_content" class="form-input" rows="6">{v["html_content"] ?? ""}</textarea>
            </div>
          </div>

          <button type="submit" class="btn btn-primary">Create Entity</button>
          <a href="/admin/entities" class="btn btn-ghost" style="margin-left:0.5rem">Cancel</a>
        </form>
      </div>
      <script>{js(entityFormScript("entity-new-root"))}</script>
    </Layout>
  );
}

interface EntityEditPageProps {
  user: string;
  entity: Entity;
  cameras: Camera[];
  error?: string;
  success?: string;
}

export function EntityEditPage(props: EntityEditPageProps) {
  const e = props.entity;
  return (
    <Layout
      title={`Entity: ${e.name}`}
      user={props.user}
      activeNav="entities"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <div id="entity-edit-root" style="max-width:600px">
        <div class="card" style="margin-bottom:1rem">
          <div style="margin-bottom:0.75rem">Type: {entityBadge(e.type)}</div>
          <form method="post" action={`/admin/entities/${e.id}`}>
            {/* Type is fixed after creation — switching type would break attached cells. */}
            <input type="hidden" name="type" value={e.type} />
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" required value={e.name} maxlength="128" />
            </div>
            <div class="form-group">
              <label for="description">Description</label>
              <input id="description" name="description" type="text" class="form-input" value={e.description ?? ""} />
            </div>

            {e.type === "camera" && (
              <div class="form-group">
                <label for="camera_id">Camera</label>
                <select id="camera_id" name="camera_id" class="form-input">
                  <option value="">-- Select --</option>
                  {props.cameras.map((cam) => (
                    <option value={String(cam.id)} selected={e.camera_id === cam.id}>{cam.name}</option>
                  ))}
                </select>
              </div>
            )}
            {e.type === "camera" && e.camera_id != null && (
              <div class="form-group">
                <label>Live Preview</label>
                <div style="background:#111827; border-radius:4px; overflow:hidden; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center">
                  <img
                    id={`snap-${String(e.id)}`}
                    src={`/admin/entities/${e.id}/snapshot?t=${String(Date.now())}`}
                    alt="Camera snapshot"
                    style="width:100%; height:100%; object-fit:contain; display:block"
                    {...{ "onerror": "this.style.display='none'; var s=this.nextElementSibling; if(s) s.style.display='block';" }}
                  />
                  <span style="display:none; color:#fca5a5; font-size:0.85rem">Snapshot failed — camera unreachable or RTSP not configured</span>
                </div>
                <div style="margin-top:0.5rem">
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    {...{ "onclick": `(function(){var img=document.getElementById('snap-${String(e.id)}'); if(img){img.style.display='block'; img.src='/admin/entities/${String(e.id)}/snapshot?t='+Date.now();}})()` }}
                  >
                    Refresh
                  </button>
                  <span style="margin-left:0.5rem; color:#666; font-size:0.8rem">Pulls one frame via ffmpeg/gst (up to ~8s).</span>
                </div>
              </div>
            )}
            {e.type === "web" && (
              <div class="form-group">
                <label for="web_url">URL</label>
                <input id="web_url" name="web_url" type="url" class="form-input" value={e.web_url ?? ""} />
              </div>
            )}
            {e.type === "html" && (
              <div class="form-group">
                <label for="html_content">HTML</label>
                <textarea id="html_content" name="html_content" class="form-input" rows="8">{e.html_content ?? ""}</textarea>
              </div>
            )}
            {e.type === "dashboard" && (
              <div class="form-group">
                <label>Node-RED Tab ID</label>
                <code style="display:block; padding:0.5rem; background:#f9fafb; border-radius:4px; font-size:0.85rem">{e.dashboard_id ?? "—"}</code>
                <div class="form-hint">
                  Synced from Node-RED. Resolved as <code>/dash/{e.dashboard_id ?? "?"}</code> in
                  kiosk bundles. Edit the dashboard contents in the Node-RED editor.
                </div>
              </div>
            )}

            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/entities" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
            {e.type === "dashboard" && (
              <a href="/admin/nodered" class="btn btn-ghost" style="margin-left:0.5rem" target="_blank" rel="noopener">Open in Node-RED</a>
            )}
          </form>
        </div>

        <form method="post" action={`/admin/entities/${e.id}/delete`}>
          <button type="submit" class="btn btn-danger" {...{"onclick": "return confirm('Delete this entity? Cells using it will be left empty.')"}}>Delete Entity</button>
        </form>
      </div>
    </Layout>
  );
}

// ---- Kiosks -----------------------------------------------------------------

interface KiosksProps {
  user: string;
  kiosks: Kiosk[];
  pendingCodes: PairingCode[];
  error?: string;
}

export function KiosksPage(props: KiosksProps) {
  return (
    <Layout title="Kiosks" user={props.user} activeNav="kiosks" flash={props.error ? { type: "error", message: props.error } : undefined}>
      <div class="two-col">
        <div>
          <div class="section-header">
            <h2 class="section-title">Paired Kiosks</h2>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Hardware</th>
                  <th>Last Seen</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {props.kiosks.length === 0 ? (
                  <tr><td colspan="4" style="text-align:center; color:#999; padding:2rem">No kiosks paired</td></tr>
                ) : (
                  props.kiosks.map((k) => (
                    <tr>
                      <td><a href={`/admin/kiosks/${k.id}`}><strong>{k.name}</strong></a></td>
                      <td style="font-size:0.85rem">{k.hardware_model ?? "—"}</td>
                      <td style="font-size:0.85rem; white-space:nowrap">{k.last_seen_at ? formatTime(k.last_seen_at) : "Never"}</td>
                      <td>
                        {k.enabled
                          ? <span class="badge badge-green">Active</span>
                          : <span class="badge badge-gray">Disabled</span>
                        }
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div class="section-header">
            <h2 class="section-title">Pair New Kiosk</h2>
          </div>
          <div class="card">
            <form method="post" action="/admin/kiosks/pair">
              <div class="form-group">
                <label for="code">Pairing Code</label>
                <input
                  id="code"
                  name="code"
                  type="text"
                  class="form-input"
                  required
                  maxlength="8"
                  pattern="[A-Z2-9]{8}"
                  style="text-transform:uppercase; text-align:center; font-size:1.25rem; letter-spacing:0.2rem"
                />
                <div class="form-hint">8-character code shown on kiosk screen.</div>
              </div>
              <div class="form-group">
                <label for="replace_kiosk_id">Replacing existing kiosk?</label>
                <select id="replace_kiosk_id" name="replace_kiosk_id" class="form-input">
                  <option value="">-- No, this is a new kiosk --</option>
                  {props.kiosks.map((k) => (
                    <option value={String(k.id)}>{k.name}{k.last_seen_at ? ` (last seen ${formatTime(k.last_seen_at)})` : " (never seen)"}</option>
                  ))}
                </select>
                <div class="form-hint">
                  Pick the kiosk this device replaces. Display, layouts, labels, and GPIO
                  bindings stay; only the device credentials roll. Old kiosk's key is revoked.
                </div>
              </div>
              <div class="form-group">
                <label for="name_override">Name Override (new kiosks only)</label>
                <input id="name_override" name="name_override" type="text" class="form-input" />
              </div>
              <div class="form-group">
                <label style="font-weight:normal">
                  <input type="checkbox" name="force" value="1" />
                  {" "}Force replace (skip hardware / capability / managed-image match check)
                </label>
              </div>
              <div class="form-group">
                <label for="initial_labels">Initial Labels (new kiosks only)</label>
                <input id="initial_labels" name="initial_labels" type="text" class="form-input" placeholder="lobby, floor-1" />
                <div class="form-hint">Comma-separated label names.</div>
              </div>
              <button type="submit" class="btn btn-primary btn-block">Pair Kiosk</button>
            </form>

            {props.pendingCodes.length > 0 && (
              <div style="margin-top:1.25rem; border-top:1px solid #eee; padding-top:1rem">
                <div style="font-weight:600; font-size:0.85rem; margin-bottom:0.5rem">Pending Codes</div>
                {props.pendingCodes.map((pc) => {
                  const managed = pc.extras?.["managed_image"] === true;
                  return (
                    <div style="font-size:0.8rem; padding:0.4rem 0; border-top:1px dashed #eee">
                      <div style="display:flex; justify-content:space-between">
                        <code style="font-size:0.95rem">{pc.code}</code>
                        <span style="color:#666">expires {formatTime(pc.expires_at)}</span>
                      </div>
                      <div style="color:#666; margin-top:0.2rem">
                        {pc.kiosk_proposed_name ? <>name: <code>{pc.kiosk_proposed_name}</code></> : "(no name)"}
                        {pc.kiosk_hardware_model ? <> · hw: <code>{pc.kiosk_hardware_model}</code></> : null}
                        {managed ? <> · <span style="color:#080">managed image</span></> : null}
                      </div>
                      {pc.kiosk_capabilities?.length > 0 ? (
                        <div style="color:#666; margin-top:0.15rem">caps: {pc.kiosk_capabilities.join(", ")}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}

// ---- Account ----------------------------------------------------------------

interface AccountProps {
  user: string;
  totpEnabled: boolean;
  error?: string;
  success?: string;
}

export function AccountPage(props: AccountProps) {
  return (
    <Layout
      title="Account"
      user={props.user}
      activeNav="account"
      flash={
        props.error
          ? { type: "error", message: props.error }
          : props.success
            ? { type: "success", message: props.success }
            : undefined
      }
    >
      <div style="max-width:600px">
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Change Password</h2>
          <form method="post" action="/admin/account/password">
            <div class="form-group">
              <label for="current_password">Current Password</label>
              <input id="current_password" name="current_password" type="password" class="form-input" required autocomplete="current-password" />
            </div>
            <div class="form-group">
              <label for="new_password">New Password</label>
              <input id="new_password" name="new_password" type="password" class="form-input" required minlength="12" autocomplete="new-password" />
              <div class="form-hint">At least 12 characters.</div>
            </div>
            <button type="submit" class="btn btn-primary">Change Password</button>
          </form>
        </div>

        <div class="card">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Two-Factor Authentication</h2>
          {props.totpEnabled ? (
            <div>
              <p style="color:#065f46; margin-bottom:1rem">
                <span class="badge badge-green">Enabled</span>
                {" "}TOTP is active on this account.
              </p>
              <form method="post" action="/admin/account/totp/disable">
                <div class="form-group">
                  <label for="disable_password">Enter password to disable</label>
                  <input id="disable_password" name="password" type="password" class="form-input" required />
                </div>
                <button type="submit" class="btn btn-danger">Disable 2FA</button>
              </form>
            </div>
          ) : (
            <div>
              <p style="color:#666; margin-bottom:1rem">
                Protect your account with a TOTP authenticator app.
              </p>
              <form method="post" action="/admin/account/totp/begin">
                <button type="submit" class="btn btn-primary">Enable 2FA</button>
              </form>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

// ---- TOTP Enrollment --------------------------------------------------------

interface TotpEnrollProps {
  user: string;
  secret: string;
  provisioningUri: string;
  recoveryCodes: string[];
}

export function TotpEnrollPage(props: TotpEnrollProps) {
  return (
    <Layout title="Enable Two-Factor Auth" user={props.user} activeNav="account">
      <div style="max-width:600px">
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Step 1: Scan QR Code</h2>
          <p style="color:#666; margin-bottom:1rem">
            Scan this with your authenticator app (Google Authenticator, Authy, etc.).
          </p>
          <div style="text-align:center; padding:1rem; background:#f9fafb; border-radius:4px; margin-bottom:1rem">
            <div id="qr-code" style="display:inline-block"></div>
          </div>
          <details>
            <summary style="cursor:pointer; color:#666; font-size:0.85rem">Can't scan? Enter manually</summary>
            <code style="display:block; padding:0.75rem; background:#f9fafb; border-radius:4px; margin-top:0.5rem; word-break:break-all; font-size:0.9rem">{props.secret}</code>
          </details>
        </div>

        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Step 2: Save Recovery Codes</h2>
          <p style="color:#dc2626; font-weight:500; margin-bottom:1rem">
            Save these codes somewhere safe. They will not be shown again.
          </p>
          <div class="code-grid">
            {props.recoveryCodes.map((code) => (
              <div class="code-item">{code}</div>
            ))}
          </div>
        </div>

        <div class="card">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Step 3: Verify</h2>
          <form method="post" action="/admin/account/totp/confirm">
            <input type="hidden" name="recovery_codes" value={JSON.stringify(props.recoveryCodes)} />
            <div class="form-group">
              <label for="code">Enter code from your authenticator</label>
              <input
                id="code"
                name="code"
                type="text"
                class="form-input"
                required
                maxlength="6"
                pattern="[0-9]{6}"
                autocomplete="one-time-code"
                inputmode="numeric"
                style="text-align:center; font-size:1.5rem; letter-spacing:0.3rem; max-width:250px"
              />
            </div>
            <button type="submit" class="btn btn-primary">Confirm &amp; Enable</button>
            <a href="/admin/account" class="btn btn-ghost" style="margin-left:0.5rem">Cancel</a>
          </form>
        </div>
      </div>
    </Layout>
  );
}

// ---- Simple list page -------------------------------------------------------

interface SimpleListProps {
  user: string;
  pageTitle: string;
  description: string;
  activeNav: string;
  items: Array<{ name: string; detail?: string; badge?: string }>;
}

export function SimpleListPage(props: SimpleListProps) {
  return (
    <Layout title={props.pageTitle} user={props.user} activeNav={props.activeNav}>
      <p style="color:#666; margin-bottom:1.25rem">{props.description}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {props.items.length === 0 ? (
              <tr><td colspan="3" style="text-align:center; color:#999; padding:2rem">None configured yet</td></tr>
            ) : (
              props.items.map((item) => (
                <tr>
                  <td>
                    <strong>{item.name}</strong>
                    {item.badge && (
                      <span class="badge" style={`margin-left:0.5rem; background-color:${item.badge}`}>{item.badge}</span>
                    )}
                  </td>
                  <td style="color:#666">{item.detail ?? ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Camera Edit ------------------------------------------------------------

interface CameraEditProps {
  user: string;
  camera: Camera;
  labels: Array<{ label_id: number; name: string }>;
  allLabels: Label[];
  streams: Array<{ id: number; role: string; name: string; rtsp_uri: string }>;
  error?: string;
  success?: string;
}

/**
 * Render the camera labels region (chips + add forms). Returned standalone so
 * htmx label add/remove can swap just this fragment via
 * hx-target="#camera-labels-<id>" hx-swap="innerHTML".
 */
export function renderCameraLabels(
  cameraId: number,
  labels: Array<{ label_id: number; name: string }>,
  allLabels: Label[],
): string {
  const labelsTargetSelector = `#camera-labels-${String(cameraId)}`;
  return (
    <div>
      {labels.length > 0 ? (
        <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem">
          {labels.map((l) => (
            <button
              type="button"
              class="badge badge-blue"
              style="cursor:pointer; border:none"
              title="Click to remove"
              hx-post={`/admin/cameras/${String(cameraId)}/labels/remove`}
              hx-vals={JSON.stringify({ label_id: l.label_id })}
              hx-target={labelsTargetSelector}
              hx-swap="innerHTML"
            >
              {l.name} ×
            </button>
          ))}
        </div>
      ) : (
        <p style="color:#999; margin-bottom:1rem">No labels attached</p>
      )}
      <form
        hx-post={`/admin/cameras/${String(cameraId)}/labels`}
        hx-target={labelsTargetSelector}
        hx-swap="innerHTML"
        style="display:flex; gap:0.5rem"
      >
        <select name="label_id" class="form-input" style="flex:1">
          {allLabels
            .filter((al) => !labels.some((l) => l.label_id === al.id))
            .map((al) => <option value={String(al.id)}>{al.name}</option>)}
        </select>
        <button type="submit" class="btn btn-primary">Add</button>
      </form>
      <form
        hx-post={`/admin/cameras/${String(cameraId)}/labels`}
        hx-target={labelsTargetSelector}
        hx-swap="innerHTML"
        style="display:flex; gap:0.5rem; margin-top:0.5rem"
      >
        <input name="new_label" type="text" class="form-input" placeholder="Or create new label..." style="flex:1" />
        <button type="submit" class="btn btn-ghost">Create &amp; Add</button>
      </form>
    </div>
  );
}

export function CameraEditPage(props: CameraEditProps) {
  const cam = props.camera;
  return (
    <Layout
      title={`Camera: ${cam.name}`}
      user={props.user}
      activeNav="cameras"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <div style="max-width:700px">
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Edit Camera</h2>
          <form method="post" action={`/admin/cameras/${cam.id}`}>
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" value={cam.name} required maxlength="128" />
            </div>
            {cam.type === "rtsp" && (() => {
              const parts = parseRtspUrl(cam.rtsp_url ?? "");
              return (
                <div>
                  <div class="form-group">
                    <label for="rtsp_host">Host</label>
                    <input id="rtsp_host" name="rtsp_host" type="text" class="form-input" value={parts.host} />
                  </div>
                  <div style="display:grid; grid-template-columns:1fr 2fr; gap:0.75rem">
                    <div class="form-group">
                      <label for="rtsp_port">Port</label>
                      <input id="rtsp_port" name="rtsp_port" type="number" class="form-input" value={parts.port} />
                    </div>
                    <div class="form-group">
                      <label for="rtsp_path">Path</label>
                      <input id="rtsp_path" name="rtsp_path" type="text" class="form-input" value={parts.path} />
                    </div>
                  </div>
                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem">
                    <div class="form-group">
                      <label for="rtsp_username">Username</label>
                      <input id="rtsp_username" name="rtsp_username" type="text" class="form-input" value={parts.username} />
                    </div>
                    <div class="form-group">
                      <label for="rtsp_password">Password (leave blank to keep)</label>
                      <input id="rtsp_password" name="rtsp_password" type="password" class="form-input" />
                    </div>
                  </div>
                </div>
              );
            })()}
            {cam.type === "onvif" && (
              <div>
                <div class="form-group">
                  <label for="onvif_host">ONVIF Host</label>
                  <input id="onvif_host" name="onvif_host" type="text" class="form-input" value={cam.onvif_host ?? ""} />
                </div>
                <div class="form-group">
                  <label for="onvif_port">Port</label>
                  <input id="onvif_port" name="onvif_port" type="number" class="form-input" value={String(cam.onvif_port ?? 80)} />
                </div>
                <div class="form-group">
                  <label for="onvif_username">Username</label>
                  <input id="onvif_username" name="onvif_username" type="text" class="form-input" value={cam.onvif_username ?? ""} />
                </div>
                <div class="form-group">
                  <label for="onvif_password">Password (leave blank to keep)</label>
                  <input id="onvif_password" name="onvif_password" type="password" class="form-input" />
                </div>
              </div>
            )}
            <div class="form-group">
              <label>
                <input type="checkbox" name="enabled" value="1" checked={cam.enabled} />
                {" "}Enabled
              </label>
            </div>
            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/cameras" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
          </form>
        </div>

        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Labels</h2>
          <div id={`camera-labels-${String(cam.id)}`}>
            {renderCameraLabels(cam.id, props.labels, props.allLabels)}
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Streams</h2>
          {props.streams.length > 0 ? (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Role</th><th>Name</th><th>URI</th></tr></thead>
                <tbody>
                  {props.streams.map((s) => (
                    <tr>
                      <td><span class="badge badge-gray">{s.role}</span></td>
                      <td>{s.name}</td>
                      <td style="font-size:0.8rem; word-break:break-all">{s.rtsp_uri}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style="color:#999">No streams configured</p>
          )}
        </div>

        <form method="post" action={`/admin/cameras/${cam.id}/delete`} style="margin-top:1rem">
          <button type="submit" class="btn btn-danger" {...{"onclick": "return confirm('Delete this camera?')"}}>Delete Camera</button>
        </form>
      </div>
    </Layout>
  );
}

// ---- Kiosk Edit -------------------------------------------------------------

interface KioskEditProps {
  user: string;
  kiosk: Kiosk;
  labels: Array<{ label_id: number; name: string; role: string }>;
  allLabels: Label[];
  displays?: Display[];
  displayLayouts?: Array<{ display: Display; layouts: LayoutType[] }>;
  gpioBindings?: KioskGpioBinding[];
  firmwareReleases?: FirmwareRelease[];
  error?: string;
  success?: string;
}

/**
 * Render the kiosk labels region (chips + add forms). Returned standalone so
 * htmx label add/remove can swap just this fragment via
 * hx-target="#kiosk-labels-<id>" hx-swap="innerHTML".
 */
export function renderKioskLabels(
  kioskId: number,
  labels: Array<{ label_id: number; name: string; role: string }>,
  allLabels: Label[],
): string {
  const labelsTargetSelector = `#kiosk-labels-${String(kioskId)}`;
  return (
    <div>
      {labels.length > 0 ? (
        <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem">
          {labels.map((l) => (
            <button
              type="button"
              class="badge badge-blue"
              style="cursor:pointer; border:none"
              title="Click to remove"
              hx-post={`/admin/kiosks/${String(kioskId)}/labels/remove`}
              hx-vals={JSON.stringify({ label_id: l.label_id })}
              hx-target={labelsTargetSelector}
              hx-swap="innerHTML"
            >
              {l.name} ({l.role}) ×
            </button>
          ))}
        </div>
      ) : (
        <p style="color:#999; margin-bottom:1rem">No labels attached</p>
      )}
      <form
        hx-post={`/admin/kiosks/${String(kioskId)}/labels`}
        hx-target={labelsTargetSelector}
        hx-swap="innerHTML"
        style="display:flex; gap:0.5rem"
      >
        <select name="label_id" class="form-input" style="flex:1">
          {allLabels
            .filter((al) => !labels.some((l) => l.label_id === al.id))
            .map((al) => <option value={String(al.id)}>{al.name}</option>)}
        </select>
        <select name="role" class="form-input" style="width:120px">
          <option value="consume">consume</option>
          <option value="operate">operate</option>
        </select>
        <button type="submit" class="btn btn-primary">Add</button>
      </form>
      <form
        hx-post={`/admin/kiosks/${String(kioskId)}/labels`}
        hx-target={labelsTargetSelector}
        hx-swap="innerHTML"
        style="display:flex; gap:0.5rem; margin-top:0.5rem"
      >
        <input name="new_label" type="text" class="form-input" placeholder="Or create new label..." style="flex:1" />
        <select name="role" class="form-input" style="width:120px">
          <option value="consume">consume</option>
          <option value="operate">operate</option>
        </select>
        <button type="submit" class="btn btn-ghost">Create &amp; Add</button>
      </form>
    </div>
  );
}

/**
 * Managed-image device config editor. Only rendered when the kiosk reported
 * managed_image=true at pairing. Server pushes the resulting JSON on the
 * next heartbeat; kiosk applies it and echoes the version back, so we show
 * "version N applied at …" plus the last error (if any) so the operator can
 * see whether their change actually landed.
 */
function ManagedConfigCard(props: { kiosk: Kiosk }) {
  const k = props.kiosk;
  let cfg: {
    hostname?: string;
    timezone?: string;
    network?: {
      mode?: string;
      interface?: string;
      ip_cidr?: string;
      gateway?: string;
      dns?: string[];
      vlan_id?: number;
    };
    wifi?: { ssid?: string };
  } = {};
  if (k.managed_config_json) {
    try { cfg = JSON.parse(k.managed_config_json); } catch { /* ignore */ }
  }
  const net = cfg.network ?? {};
  const wifi = cfg.wifi ?? {};
  const pending = k.managed_config_version > k.managed_config_applied_version;
  return (
    <div class="card" style="margin-bottom:1.5rem">
      <h2 style="margin:0 0 1rem; font-size:1.1rem">Managed Config (Pi image)</h2>
      <div style="font-size:0.85rem; color:#666; margin-bottom:0.75rem">
        <div>
          Version: {String(k.managed_config_version)}
          {" · Applied: "}{String(k.managed_config_applied_version)}
          {k.managed_config_applied_at ? <> ({formatTime(k.managed_config_applied_at)})</> : null}
          {pending ? <span style="color:#b06; margin-left:0.5rem">pending push…</span> : null}
        </div>
        {k.managed_config_error
          ? <div style="color:#b00; margin-top:0.25rem">Last error: {k.managed_config_error}</div>
          : null}
      </div>
      <form method="post" action={`/admin/kiosks/${k.id}/managed-config`}>
        <div class="form-group">
          <label for="mc_hostname">Hostname</label>
          <input id="mc_hostname" name="hostname" type="text" class="form-input"
            value={cfg.hostname ?? ""} placeholder="betterframe-kiosk" />
        </div>
        <div class="form-group">
          <label for="mc_timezone">Timezone</label>
          <input id="mc_timezone" name="timezone" type="text" class="form-input"
            value={cfg.timezone ?? ""} placeholder="Etc/UTC" />
        </div>

        <h3 style="margin:1rem 0 0.5rem; font-size:0.95rem">Network</h3>
        <div class="form-group">
          <label for="mc_net_mode">Mode</label>
          <select id="mc_net_mode" name="network_mode" class="form-input">
            <option value="" selected={!net.mode}>—</option>
            <option value="dhcp" selected={net.mode === "dhcp"}>DHCP</option>
            <option value="static" selected={net.mode === "static"}>Static</option>
          </select>
        </div>
        <div class="form-group">
          <label for="mc_net_iface">Interface</label>
          <input id="mc_net_iface" name="network_interface" type="text" class="form-input"
            value={net.interface ?? ""} placeholder="eth0" />
        </div>
        <div class="form-group">
          <label for="mc_net_ip">Static IP (CIDR)</label>
          <input id="mc_net_ip" name="network_ip_cidr" type="text" class="form-input"
            value={net.ip_cidr ?? ""} placeholder="192.168.1.50/24" />
        </div>
        <div class="form-group">
          <label for="mc_net_gw">Gateway</label>
          <input id="mc_net_gw" name="network_gateway" type="text" class="form-input"
            value={net.gateway ?? ""} placeholder="192.168.1.1" />
        </div>
        <div class="form-group">
          <label for="mc_net_dns">DNS (comma-separated)</label>
          <input id="mc_net_dns" name="network_dns" type="text" class="form-input"
            value={(net.dns ?? []).join(", ")} placeholder="1.1.1.1, 8.8.8.8" />
        </div>
        <div class="form-group">
          <label for="mc_net_vlan">VLAN ID</label>
          <input id="mc_net_vlan" name="network_vlan_id" type="number" min="1" max="4094"
            class="form-input" value={net.vlan_id != null ? String(net.vlan_id) : ""} />
        </div>

        <h3 style="margin:1rem 0 0.5rem; font-size:0.95rem">Wi-Fi (optional)</h3>
        <div class="form-group">
          <label for="mc_wifi_ssid">SSID</label>
          <input id="mc_wifi_ssid" name="wifi_ssid" type="text" class="form-input"
            value={wifi.ssid ?? ""} />
        </div>
        <div class="form-group">
          <label for="mc_wifi_psk">PSK</label>
          <input id="mc_wifi_psk" name="wifi_psk" type="password" class="form-input"
            placeholder={wifi.ssid ? "(unchanged — leave blank to keep)" : ""} />
          <div style="font-size:0.75rem; color:#999; margin-top:0.2rem">
            Encrypted with cluster key before storage. Leave blank to keep existing PSK.
          </div>
        </div>

        <button type="submit" class="btn btn-primary">Save &amp; Push</button>
      </form>
    </div>
  );
}

export function KioskEditPage(props: KioskEditProps) {
  const k = props.kiosk;
  return (
    <Layout
      title={`Kiosk: ${k.name}`}
      user={props.user}
      activeNav="kiosks"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <div style="max-width:700px">
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Edit Kiosk</h2>
          <form method="post" action={`/admin/kiosks/${k.id}`}>
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" value={k.name} required />
            </div>
            <div class="form-group">
              <label>
                <input type="checkbox" name="enabled" value="1" checked={k.enabled} />
                {" "}Enabled
              </label>
            </div>
            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/kiosks" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
          </form>
          <div style="margin-top:1rem; color:#666; font-size:0.85rem">
            <div>Hardware: {k.hardware_model ?? "—"}</div>
            <div>Paired: {k.paired_at ? formatTime(k.paired_at) : "—"}</div>
            <div>Last seen: {k.last_seen_at ? formatTime(k.last_seen_at) : "Never"}</div>
          </div>
          <div style="margin-top:1rem; padding-top:1rem; border-top:1px solid #eee">
            <div style="font-size:0.85rem; font-weight:600; margin-bottom:0.5rem">Display Power</div>
            <button
              type="button"
              class="btn btn-sm"
              {...{
                "hx-post": `/admin/kiosks/${String(k.id)}/power/wake`,
                "hx-swap": "none",
              }}
            >Wake</button>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              style="margin-left:0.5rem"
              {...{
                "hx-post": `/admin/kiosks/${String(k.id)}/power/standby`,
                "hx-swap": "none",
              }}
            >Standby</button>
          </div>

          {props.displayLayouts && props.displayLayouts.length > 0 ? (
            <div style="margin-top:1rem; padding-top:1rem; border-top:1px solid #eee">
              <div style="font-size:0.85rem; font-weight:600; margin-bottom:0.5rem">Switch Layout By Display</div>
              <div style="display:grid; gap:0.75rem">
                {props.displayLayouts.map(({ display, layouts }) => (
                  <form
                    method="post"
                    action={`/admin/displays/${String(display.id)}/layout`}
                    style="display:grid; grid-template-columns:minmax(130px, 0.8fr) minmax(180px, 1fr) auto; gap:0.5rem; align-items:center"
                    {...{
                      "hx-post": `/admin/displays/${String(display.id)}/layout`,
                      "hx-swap": "none",
                    }}
                  >
                    <div style="font-size:0.85rem">
                      <a href={`/admin/displays/${String(display.id)}`}><strong>{display.name}</strong></a>
                      <div style="color:#666; font-size:0.75rem">{String(display.width_px)}x{String(display.height_px)}</div>
                    </div>
                    {layouts.length > 0 ? (
                      <select name="layout_id" class="form-input">
                        {layouts.map((l) => (
                          <option value={String(l.id)}>{l.name}</option>
                        ))}
                      </select>
                    ) : (
                      <span style="color:#999; font-size:0.85rem">No attached layouts</span>
                    )}
                    <button
                      type="submit"
                      class="btn btn-sm"
                      disabled={layouts.length === 0}
                    >Switch</button>
                  </form>
                )).join("")}
              </div>
            </div>
          ) : null}

          <div style="margin-top:1rem; padding-top:1rem; border-top:1px solid #eee">
            <div style="font-size:0.85rem; font-weight:600; margin-bottom:0.5rem">Hardware</div>
            <div style="display:flex; gap:1.5rem; flex-wrap:wrap; font-size:0.85rem; color:#666; margin-bottom:0.75rem">
              <div>CPU: {k.cpu_temp_c != null ? `${k.cpu_temp_c.toFixed(1)}°C` : "—"}</div>
              <div>Fan: {k.fan_rpm != null ? `${k.fan_rpm} RPM` : "—"}</div>
              <div>CPU Load: {percentText(k.cpu_load_percent)}</div>
              <div>RAM: {mbPair(k.memory_used_mb, k.memory_total_mb)}</div>
              <div>Disk: {k.disk_free_mb != null && k.disk_total_mb != null ? `${String(k.disk_free_mb)} MB free / ${String(k.disk_total_mb)} MB` : "—"} {k.disk_used_percent != null ? `(${k.disk_used_percent.toFixed(1)}%)` : ""}</div>
              <div>PWM: {k.fan_pwm != null ? `${k.fan_pwm}/255` : "—"}</div>
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                {...{
                  "hx-post": `/admin/kiosks/${String(k.id)}/fan`,
                  "hx-vals": JSON.stringify({ mode: "auto" }),
                  "hx-swap": "none",
                }}
              >Auto</button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                {...{
                  "hx-post": `/admin/kiosks/${String(k.id)}/fan`,
                  "hx-vals": JSON.stringify({ pwm: "0" }),
                  "hx-swap": "none",
                }}
              >Off</button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                {...{
                  "hx-post": `/admin/kiosks/${String(k.id)}/fan`,
                  "hx-vals": JSON.stringify({ pwm: "128" }),
                  "hx-swap": "none",
                }}
              >50%</button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                {...{
                  "hx-post": `/admin/kiosks/${String(k.id)}/fan`,
                  "hx-vals": JSON.stringify({ pwm: "255" }),
                  "hx-swap": "none",
                }}
              >Full</button>
            </div>
          </div>
        </div>

        {/* Associated displays */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Displays</h2>
          {props.displays && props.displays.length > 0 ? (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Resolution</th><th>Index</th><th>Power</th></tr></thead>
                <tbody>
                  {props.displays.map((d) => (
                    <tr>
                      <td><a href={`/admin/displays/${d.id}`}><strong>{d.name}</strong></a></td>
                      <td>{String(d.width_px)}x{String(d.height_px)}</td>
                      <td>{String(d.index)}</td>
                      <td>{powerBadge(d.actual_power_state)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style="color:#999">No displays associated with this kiosk</p>
          )}
        </div>

        {props.firmwareReleases && (
          KioskFirmwarePanel({ kiosk: props.kiosk, releases: props.firmwareReleases })
        )}

        {(props.kiosk.local_key && props.kiosk.local_port) && KioskLocalPanel({ kiosk: props.kiosk })}

        {/* GPIO bindings */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">GPIO Bindings</h2>
          <p style="color:#666; font-size:0.85rem; margin-bottom:1rem">
            Each input binding fires an event with the configured topic when the
            pin's edge triggers. Pi 5's main GPIO chip is <code>gpiochip4</code>;
            older Pis use <code>gpiochip0</code>.
          </p>
          {props.gpioBindings && props.gpioBindings.length > 0 ? (
            <div class="table-wrap" style="margin-bottom:1rem">
              <table>
                <thead>
                  <tr>
                    <th>Chip</th>
                    <th>Pin</th>
                    <th>Dir</th>
                    <th>Pull</th>
                    <th>Edge</th>
                    <th>Topic</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {props.gpioBindings.map((g) => (
                    <tr>
                      <td style="font-family:monospace; font-size:0.85rem">{g.chip}</td>
                      <td style="font-family:monospace">{String(g.pin)}</td>
                      <td><span class="badge badge-gray">{g.direction}</span></td>
                      <td style="font-size:0.85rem">{g.pull ?? "—"}</td>
                      <td style="font-size:0.85rem">{g.edge ?? "—"}</td>
                      <td style="font-family:monospace; font-size:0.85rem">{g.topic}</td>
                      <td>
                        <button
                          type="button"
                          class="btn btn-sm btn-danger"
                          {...{
                            "hx-post": `/admin/kiosks/${String(k.id)}/gpio/${String(g.id)}/delete`,
                            "hx-target": "closest tr",
                            "hx-swap": "outerHTML",
                            "hx-confirm": "Remove GPIO binding?",
                          }}
                        >×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style="color:#999; margin-bottom:1rem">No GPIO bindings configured</p>
          )}

          <form method="post" action={`/admin/kiosks/${k.id}/gpio`} style="display:grid; grid-template-columns:repeat(6, 1fr) auto; gap:0.5rem; align-items:end">
            <div>
              <label style="font-size:0.75rem; color:#666">Chip</label>
              <input name="chip" class="form-input" value="gpiochip0" />
            </div>
            <div>
              <label style="font-size:0.75rem; color:#666">Pin</label>
              <input name="pin" type="number" class="form-input" required min="0" />
            </div>
            <div>
              <label style="font-size:0.75rem; color:#666">Dir</label>
              <select name="direction" class="form-input">
                <option value="in">in</option>
                <option value="out">out</option>
              </select>
            </div>
            <div>
              <label style="font-size:0.75rem; color:#666">Pull</label>
              <select name="pull" class="form-input">
                <option value="">—</option>
                <option value="up">up</option>
                <option value="down">down</option>
                <option value="none">none</option>
              </select>
            </div>
            <div>
              <label style="font-size:0.75rem; color:#666">Edge</label>
              <select name="edge" class="form-input">
                <option value="">—</option>
                <option value="rising">rising</option>
                <option value="falling">falling</option>
                <option value="both">both</option>
              </select>
            </div>
            <div>
              <label style="font-size:0.75rem; color:#666">Topic</label>
              <input name="topic" class="form-input" required placeholder="gpio/button-1" />
            </div>
            <button type="submit" class="btn btn-primary btn-sm">Add</button>
          </form>
        </div>

        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Labels</h2>
          <div id={`kiosk-labels-${String(k.id)}`}>
            {renderKioskLabels(k.id, props.labels, props.allLabels)}
          </div>
        </div>

        {k.managed_image ? <ManagedConfigCard kiosk={k} /> : null}

        <form method="post" action={`/admin/kiosks/${k.id}/delete`} style="margin-top:1rem">
          <button type="submit" class="btn btn-danger" {...{"onclick": "return confirm('Delete this kiosk?')"}}>Delete Kiosk</button>
        </form>
      </div>
    </Layout>
  );
}

// ---- Labels Management ------------------------------------------------------

interface LabelsPageProps {
  user: string;
  labels: Label[];
  error?: string;
}

export function LabelsPage(props: LabelsPageProps) {
  return (
    <Layout
      title="Labels"
      user={props.user}
      activeNav="labels"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <div class="section-header">
        <h2 class="section-title">All Labels</h2>
      </div>
      <div style="max-width:500px; margin-bottom:1.5rem">
        <form method="post" action="/admin/labels/new" style="display:flex; gap:0.5rem">
          <input name="name" type="text" class="form-input" placeholder="New label name" required pattern="[a-z0-9][a-z0-9_-]*" style="flex:1" />
          <input name="color" type="color" value="#2563eb" style="width:40px; height:38px; border:1px solid #d0d0d0; border-radius:4px" />
          <button type="submit" class="btn btn-primary">Create</button>
        </form>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Color</th><th>Actions</th></tr></thead>
          <tbody>
            {props.labels.length === 0 ? (
              <tr><td colspan="3" style="text-align:center; color:#999; padding:2rem">No labels</td></tr>
            ) : (
              props.labels.map((l) => (
                <tr>
                  <td><strong>{l.name}</strong></td>
                  <td>{l.color ? <span class="badge" style={`background-color:${l.color}; color:#fff`}>{l.color}</span> : "—"}</td>
                  <td>
                    <form method="post" action={`/admin/labels/${l.id}/delete`} style="display:inline">
                      <button type="submit" class="btn btn-sm btn-danger" {...{"onclick": "return confirm('Delete label?')"}}>Delete</button>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Layouts ----------------------------------------------------------------

interface LayoutsPageProps {
  user: string;
  layouts: LayoutType[];
  /** layout_id → number of displays the layout is attached to */
  displayCounts: Map<number, number>;
}

export function LayoutsPage(props: LayoutsPageProps) {
  return (
    <Layout title="Layouts" user={props.user} activeNav="layouts">
      <div class="section-header">
        <h2 class="section-title">All Layouts</h2>
        <a href="/admin/layouts/new" class="btn btn-primary">New Layout</a>
      </div>
      <p style="color:#666; margin-bottom:1.25rem">
        Layouts are standalone — they define a grid of regions and bind cameras or
        other content into them. Attach a layout to one or more displays from the
        display's edit page.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Displays</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            {props.layouts.length === 0 ? (
              <tr><td colspan="3" style="text-align:center; color:#999; padding:2rem">No layouts created yet</td></tr>
            ) : (
              props.layouts.map((l) => {
                const count = props.displayCounts.get(l.id) ?? 0;
                return (
                  <tr>
                    <td><a href={`/admin/layouts/${l.id}`}><strong>{l.name}</strong></a></td>
                    <td>
                      {count === 0
                        ? <span style="color:#999">unattached</span>
                        : <span>{String(count)} display{count !== 1 ? "s" : ""}</span>}
                    </td>
                    <td>
                      {l.priority === "hot"
                        ? <span class="badge badge-red">hot</span>
                        : l.priority === "cold"
                          ? <span class="badge badge-blue">cold</span>
                          : <span class="badge badge-gray">normal</span>
                      }
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Layout New -------------------------------------------------------------

interface LayoutNewPageProps {
  user: string;
  error?: string;
  values?: Record<string, string>;
}

export function LayoutNewPage(props: LayoutNewPageProps) {
  const v = props.values ?? {};
  return (
    <Layout
      title="New Layout"
      user={props.user}
      activeNav="layouts"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <div style="max-width:600px">
        <p style="color:#666; margin-bottom:1.25rem">
          Create an empty layout. You'll add cells visually on the next page,
          then attach the layout to one or more displays.
        </p>
        <div class="card">
          <form method="post" action="/admin/layouts/new">
            <div class="form-group">
              <label for="name">Layout Name</label>
              <input id="name" name="name" type="text" class="form-input" required maxlength="128" value={v["name"] ?? ""} />
            </div>

            <div class="form-group">
              <label for="description">Description (optional)</label>
              <input id="description" name="description" type="text" class="form-input" value={v["description"] ?? ""} />
            </div>

            <div class="form-group">
              <label for="priority">Priority</label>
              <select id="priority" name="priority" class="form-input">
                <option value="normal" selected={v["priority"] !== "hot" && v["priority"] !== "cold"}>Normal</option>
                <option value="hot" selected={v["priority"] === "hot"}>Hot (always warm)</option>
                <option value="cold" selected={v["priority"] === "cold"}>Cold</option>
              </select>
            </div>

            <div class="form-group">
              <label>
                <input type="checkbox" name="resets_idle_timer" value="1" checked={v["resets_idle_timer"] !== "0"} />
                {" "}Resets idle timer when activated
              </label>
            </div>

            <button type="submit" class="btn btn-primary">Create Layout</button>
            <a href="/admin/layouts" class="btn btn-ghost" style="margin-left:0.5rem">Cancel</a>
          </form>
        </div>
      </div>
    </Layout>
  );
}

// ---- Layout Edit ------------------------------------------------------------

interface LayoutEditPageProps {
  user: string;
  layout: LayoutType;
  /** Displays this layout is attached to (informational, read-only). */
  displays: Display[];
  cells: LayoutCell[];
  cameras: Camera[];
  entities: Entity[];
  /** If set, render the content-assignment form for this cell beneath the grid. */
  selectedCellId?: number | null;
  error?: string;
  success?: string;
}

export const LAYOUT_BUILDER_CSS = `
.layout-builder { display: grid; gap: 4px; aspect-ratio: 16/9; max-width: 100%; background: #ddd; padding: 4px; border-radius: 4px; }
.layout-cell { background: #fff; border: 2px solid #2563eb; border-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; position: relative; min-height: 60px; padding: 4px; text-align: center; font-size: 0.85rem; font-weight: 600; color: #1e40af; overflow: visible; }
.layout-cell:hover { background: #f0f7ff; }
.layout-cell.editing { background: #f9fafb; border-color: #1e40af; box-shadow: 0 0 0 2px #1e40af33; cursor: default; align-items: stretch; justify-content: stretch; text-align: left; font-weight: 400; color: inherit; padding: 8px; overflow: auto; }
.layout-cell-empty-text { color: #999; font-size: 0.75rem; font-weight: 400; }
.layout-cell-side { position: absolute; opacity: 0; transition: opacity 0.2s; z-index: 3; }
.layout-cell:hover .layout-cell-side, .layout-cell-side:hover { opacity: 1; }
.layout-cell-side-top { top: -12px; left: 50%; transform: translateX(-50%); }
.layout-cell-side-right { right: -12px; top: 50%; transform: translateY(-50%); }
.layout-cell-side-bottom { bottom: -12px; left: 50%; transform: translateX(-50%); }
.layout-cell-side-left { left: -12px; top: 50%; transform: translateY(-50%); }
.layout-cell-side-trigger { background: #2563eb; color: #fff; border: none; width: 24px; height: 24px; border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; padding: 0; }
.layout-cell-side-trigger:hover { background: #1e40af; }
.layout-cell-side-menu { display: none; position: absolute; gap: 4px; background: #111827; border-radius: 4px; padding: 4px; box-shadow: 0 8px 18px rgba(15, 23, 42, 0.25); left: 50%; top: 50%; transform: translate(-50%, -50%); }
.layout-cell-side:hover .layout-cell-side-menu { display: flex; }
.layout-cell-side-menu button { background: #fff; color: #111827; border: none; border-radius: 3px; cursor: pointer; font-size: 0.7rem; line-height: 1; padding: 5px 7px; white-space: nowrap; }
.layout-cell-side-menu button:hover { background: #dbeafe; color: #1e40af; }
.layout-cell-delete { position: absolute; top: 4px; right: 4px; background: rgba(220, 38, 38, 0.9); color: #fff; border: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; font-size: 12px; line-height: 1; padding: 0; opacity: 0; transition: opacity 0.2s; z-index: 2; }
.layout-cell:hover .layout-cell-delete { opacity: 1; }
.layout-cell-edit-form { width: 100%; }
.layout-cell-edit-form .form-group { margin-bottom: 0.5rem; }
.layout-cell-edit-form label { font-size: 0.75rem; font-weight: 600; display: block; margin-bottom: 0.15rem; }
.layout-cell-edit-form .form-input, .layout-cell-edit-form input, .layout-cell-edit-form select, .layout-cell-edit-form textarea { font-size: 0.8rem; padding: 0.25rem 0.4rem; width: 100%; box-sizing: border-box; }
.layout-cell-edit-form .btn { font-size: 0.75rem; padding: 0.25rem 0.6rem; }
.layout-cell-edit-form-actions { display: flex; gap: 0.35rem; margin-top: 0.5rem; flex-wrap: wrap; }
.layout-cell-edit-form .span-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; }
.layout-empty { display: flex; align-items: center; justify-content: center; aspect-ratio: 16/9; background: #f3f4f6; border-radius: 4px; }
.layout-empty-add { background: #2563eb; color: #fff; border: none; width: 80px; height: 80px; border-radius: 50%; cursor: pointer; font-size: 36px; line-height: 1; padding: 0; }
.layout-empty-add:hover { background: #1e40af; }
`;

function cellLabel(
  c: LayoutCell,
  entityById: Map<number, Entity>,
  cameraById: Map<number, Camera>,
): string {
  if (c.entity_id != null) {
    const ent = entityById.get(c.entity_id);
    if (ent) return ent.name;
  }
  if (c.content_type === "camera" && c.camera_id) {
    return cameraById.get(c.camera_id)?.name ?? `cam #${String(c.camera_id)}`;
  }
  if (c.content_type === "none") return "None";
  if (c.content_type === "web") return c.web_url ? `Web: ${c.web_url}` : "Web";
  if (c.content_type === "html") return c.html_content ? "HTML" : "HTML (empty)";
  return "Empty";
}

function cellGridStyle(c: LayoutCell): string {
  return `grid-column:${String(c.col + 1)} / span ${String(c.col_span)}; grid-row:${String(c.row + 1)} / span ${String(c.row_span)};`;
}

/**
 * Render a single cell, either in read-only display mode or edit mode (form
 * inline inside the cell). Returns a `<div class="layout-cell" ...>` element
 * suitable for hx-swap="outerHTML" against itself.
 */
export function renderCell(
  layoutId: number,
  c: LayoutCell,
  entities: Entity[],
  cameras: Camera[],
  mode: "read" | "edit",
): string {
  const cameraById = new Map<number, Camera>();
  for (const cam of cameras) cameraById.set(cam.id, cam);
  const entityById = new Map<number, Entity>();
  for (const e of entities) entityById.set(e.id, e);
  const style = cellGridStyle(c);
  const cellGetUrl = `/admin/layouts/${String(layoutId)}/cells/${String(c.id)}`;
  const cellEditUrl = `${cellGetUrl}/edit`;
  const addUrl = `/admin/layouts/${String(layoutId)}/cells`;
  const deleteUrl = `${cellGetUrl}/delete`;
  const resizeUrl = `${cellGetUrl}/resize`;

  if (mode === "edit") {
    return (
      <div class="layout-cell editing" style={style} id={`cell-${String(c.id)}`}>
        <form
          class="layout-cell-edit-form"
          hx-post={cellGetUrl}
          hx-target={`#cell-${String(c.id)}`}
          hx-swap="outerHTML"
        >
          <div class="form-group">
            <label>Entity</label>
            <select name="entity_id" class="form-input">
              <option value="">-- Empty --</option>
              {entities.map((e) => (
                <option value={String(e.id)} selected={c.entity_id === e.id}>
                  [{e.type}] {e.name}
                </option>
              ))}
            </select>
            <div class="form-hint" style="font-size:0.7rem">
              <a href="/admin/entities/new" target="_blank">+ New entity</a>
            </div>
          </div>

          <div class="form-group" style={(c.entity_id != null && entityById.get(c.entity_id)?.type === "camera") ? "" : "display:none"}>
            <label>Stream</label>
            <select name="stream_selector" class="form-input">
              <option value="auto" selected={c.stream_selector === "auto"}>Auto</option>
              <option value="main" selected={c.stream_selector === "main"}>Main</option>
              <option value="sub" selected={c.stream_selector === "sub"}>Sub</option>
            </select>
          </div>

          <div class="form-group">
            <label>Fit</label>
            <select name="fit" class="form-input">
              <option value="cover" selected={c.fit === "cover"}>Cover (fill, crop overflow)</option>
              <option value="contain" selected={c.fit === "contain"}>Contain (letterbox)</option>
              <option value="fill" selected={c.fit === "fill"}>Fill (stretch)</option>
            </select>
          </div>

          <div class="form-group span-grid">
            <div>
              <label>Width</label>
              <input name="col_span" type="number" class="form-input" min="1" value={String(c.col_span)} />
            </div>
            <div>
              <label>Height</label>
              <input name="row_span" type="number" class="form-input" min="1" value={String(c.row_span)} />
            </div>
          </div>

          <div class="layout-cell-edit-form-actions">
            <button type="submit" class="btn btn-primary">Save</button>
            <button
              type="button"
              class="btn btn-ghost"
              hx-get={cellGetUrl}
              hx-target={`#cell-${String(c.id)}`}
              hx-swap="outerHTML"
            >Cancel</button>
            <button
              type="button"
              class="btn btn-danger"
              hx-post={deleteUrl}
              hx-target="#layout-grid"
              hx-swap="innerHTML"
              hx-confirm="Delete this cell?"
            >Delete</button>
          </div>
        </form>
      </div>
    );
  }

  // Read mode. Empty when no entity is bound.
  const ent = c.entity_id != null ? entityById.get(c.entity_id) ?? null : null;
  const isEmpty = !ent && (
    c.content_type === "none"
    || (c.content_type === "html" && !c.html_content)
    || (c.content_type === "camera" && !c.camera_id)
    || (c.content_type === "web" && !c.web_url)
  );
  const label = cellLabel(c, entityById, cameraById);

  return (
    <div
      class="layout-cell"
      id={`cell-${String(c.id)}`}
      style={style}
      hx-get={cellEditUrl}
      hx-target="this"
      hx-swap="outerHTML"
      hx-trigger="click"
    >
      {isEmpty
        ? <span class="layout-cell-empty-text">{label}</span>
        : <span>{label}</span>}

      {/* + buttons (4 sides) — htmx posts to add endpoint, swaps grid */}
      {(["top", "right", "bottom", "left"] as const).map((dir) => {
        const directionParam = dir === "top" ? "above" : dir;
        return (
          <div class={`layout-cell-side layout-cell-side-${dir}`} {...{ "onclick": "event.stopPropagation()" }}>
            <button type="button" class="layout-cell-side-trigger" title={`Actions ${dir}`}>+</button>
            <div class="layout-cell-side-menu">
              <button
                type="button"
                title={`Expand ${dir}`}
                hx-post={resizeUrl}
                hx-vals={JSON.stringify({ direction: directionParam })}
                hx-target="#layout-grid"
                hx-swap="innerHTML"
              >Expand</button>
              <button
                type="button"
                title={`Add cell ${dir}`}
                hx-post={addUrl}
                hx-vals={JSON.stringify({ after_cell_id: c.id, direction: directionParam })}
                hx-target="#layout-grid"
                hx-swap="innerHTML"
              >Add</button>
            </div>
          </div>
        );
      })}

      {/* delete button */}
      <button
        type="button"
        class="layout-cell-delete"
        title="Delete cell"
        hx-post={deleteUrl}
        hx-target="#layout-grid"
        hx-swap="innerHTML"
        hx-confirm="Delete this cell?"
        {...{ "onclick": "event.stopPropagation()" }}
      >×</button>
    </div>
  );
}

/**
 * Render the inner content of the `#layout-grid` container — either the empty
 * placeholder or the full builder grid with all cells. This is what htmx swaps
 * in via `hx-target="#layout-grid" hx-swap="innerHTML"` after add/delete/resize.
 */
export function renderGrid(
  layoutId: number,
  cells: LayoutCell[],
  entities: Entity[],
  cameras: Camera[],
): string {
  if (cells.length === 0) {
    return (
      <div class="layout-empty">
        <button
          type="button"
          class="layout-empty-add"
          title="Add first cell"
          hx-post={`/admin/layouts/${String(layoutId)}/cells`}
          hx-vals={JSON.stringify({ row: 0, col: 0 })}
          hx-target="#layout-grid"
          hx-swap="innerHTML"
        >+</button>
      </div>
    );
  }

  // Compute grid dimensions.
  let gridCols = 1;
  let gridRows = 1;
  for (const c of cells) {
    const right = c.col + c.col_span;
    const bottom = c.row + c.row_span;
    if (right > gridCols) gridCols = right;
    if (bottom > gridRows) gridRows = bottom;
  }

  return (
    <div
      class="layout-builder"
      style={`grid-template-columns:repeat(${String(gridCols)}, 1fr); grid-template-rows:repeat(${String(gridRows)}, 1fr)`}
    >
      {cells.map((c) => renderCell(layoutId, c, entities, cameras, "read"))}
    </div>
  );
}

export function LayoutEditPage(props: LayoutEditPageProps) {
  const l = props.layout;
  const cells = props.cells;

  // Compute grid dimensions from cells (for summary text).
  let gridCols = 1;
  let gridRows = 1;
  for (const c of cells) {
    const right = c.col + c.col_span;
    const bottom = c.row + c.row_span;
    if (right > gridCols) gridCols = right;
    if (bottom > gridRows) gridRows = bottom;
  }

  return (
    <Layout
      title={`Layout: ${l.name}`}
      user={props.user}
      activeNav="layouts"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <style>{LAYOUT_BUILDER_CSS}</style>
      <div style="max-width:900px">
        {/* Settings */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Settings</h2>
          <form method="post" action={`/admin/layouts/${l.id}`}>
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" value={l.name} required maxlength="128" />
            </div>
            <div class="form-group">
              <label for="description">Description</label>
              <input id="description" name="description" type="text" class="form-input" value={l.description ?? ""} />
            </div>
            <div class="form-group">
              <label for="priority">Priority</label>
              <select id="priority" name="priority" class="form-input">
                <option value="normal" selected={l.priority === "normal"}>Normal</option>
                <option value="hot" selected={l.priority === "hot"}>Hot</option>
                <option value="cold" selected={l.priority === "cold"}>Cold</option>
              </select>
            </div>
            <div class="form-group">
              <label for="cooling_timeout_seconds">Cooling Timeout (seconds)</label>
              <input id="cooling_timeout_seconds" name="cooling_timeout_seconds" type="number" class="form-input" value={l.cooling_timeout_seconds != null ? String(l.cooling_timeout_seconds) : ""} min="0" placeholder="None" />
              <div class="form-hint">How long streams stay warm after leaving this layout. Leave blank for no timeout.</div>
            </div>
            <div class="form-group">
              <label>
                <input type="checkbox" name="resets_idle_timer" value="1" checked={l.resets_idle_timer} />
                {" "}Resets idle timer
              </label>
            </div>
            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/layouts" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
          </form>
          <div style="margin-top:1rem; color:#666; font-size:0.85rem">
            <div>Grid: {String(gridCols)}x{String(gridRows)}, {String(cells.length)} cell{cells.length !== 1 ? "s" : ""}</div>
            <div>
              {props.displays.length === 0
                ? <span>Attached to no displays — attach from a display's edit page.</span>
                : (
                  <span>
                    Attached to:{" "}
                    {props.displays.map((d, i) => (
                      <span>
                        {i > 0 ? ", " : ""}
                        <a href={`/admin/displays/${d.id}`}>{d.name}</a>
                      </span>
                    ))}
                  </span>
                )}
            </div>
          </div>
        </div>

        {/* Visual builder */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Layout Builder</h2>
          <p style="color:#666; font-size:0.85rem; margin-bottom:1rem">
            Hover a side <strong>+</strong> to add a neighbour or expand the cell.
            Expanding pushes cells in that direction out of the way. Click a cell
            to edit content in-place.
          </p>
          <div id="layout-grid">
            {renderGrid(l.id, cells, props.entities, props.cameras)}
          </div>
        </div>

        <form method="post" action={`/admin/layouts/${l.id}/delete`} style="margin-top:1rem">
          <button type="submit" class="btn btn-danger" {...{"onclick": "return confirm('Delete this layout and all its cells?')"}}>Delete Layout</button>
        </form>
      </div>
    </Layout>
  );
}

// ---- Display Edit -----------------------------------------------------------

interface DisplayEditPageProps {
  user: string;
  display: Display;
  /** Layouts currently attached to this display. */
  attachedLayouts: LayoutType[];
  /** All other layouts that could be attached. */
  availableLayouts: LayoutType[];
  kioskName?: string | null;
  error?: string;
  success?: string;
}

/**
 * Render the attached + available layouts region for a display. Returned
 * standalone so htmx attach/detach can swap just this fragment via
 * hx-target="#display-layouts-<id>" hx-swap="innerHTML".
 *
 * Both lists render as flat tables with the same columns. Available rows
 * leave Priority + Default blank and show an Attach button. The
 * default-layout `<select>` outside this fragment is kept in sync via an
 * htmx out-of-band swap appended by the route handler — see
 * `renderDefaultLayoutSelect`.
 */
export function renderDisplayLayouts(
  displayId: number,
  defaultLayoutId: number | null,
  attached: LayoutType[],
  available: LayoutType[],
): string {
  const target = `#display-layouts-${String(displayId)}`;
  return (
    <div>
      <h3 style="margin:0 0 0.5rem; font-size:0.95rem">Attached</h3>
      {attached.length === 0 ? (
        <p style="color:#999; margin-bottom:1rem; font-size:0.85rem">No layouts attached yet.</p>
      ) : (
        <div class="table-wrap" style="margin-bottom:1.5rem">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Priority</th>
                <th>Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {attached.map((l) => (
                <tr>
                  <td><a href={`/admin/layouts/${String(l.id)}`}><strong>{l.name}</strong></a></td>
                  <td><span class={`badge ${l.priority === "hot" ? "badge-red" : l.priority === "cold" ? "badge-blue" : "badge-gray"}`}>{l.priority}</span></td>
                  <td>{defaultLayoutId === l.id ? <span class="badge badge-green">Yes</span> : ""}</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-sm"
                      style="margin-right:0.25rem"
                      {...{
                        "hx-post": `/admin/displays/${String(displayId)}/layout/${String(l.id)}`,
                        "hx-swap": "none",
                      }}
                    >Show</button>
                    <button
                      type="button"
                      class="btn btn-sm btn-danger"
                      {...{
                        "hx-post": `/admin/displays/${String(displayId)}/layouts/${String(l.id)}/remove`,
                        "hx-target": target,
                        "hx-swap": "innerHTML",
                        "hx-confirm": "Detach this layout from the display?",
                      }}
                    >Detach</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style="margin:0 0 0.5rem; font-size:0.95rem">Available</h3>
      {available.length === 0 ? (
        <p style="color:#999; font-size:0.85rem; margin:0">
          {attached.length === 0
            ? <span>No layouts exist yet. <a href="/admin/layouts/new">Create one</a>.</span>
            : "All existing layouts are already attached."}
        </p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Priority</th>
                <th>Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {available.map((l) => (
                <tr>
                  <td><a href={`/admin/layouts/${String(l.id)}`}><strong>{l.name}</strong></a></td>
                  <td></td>
                  <td></td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-sm btn-success"
                      {...{
                        "hx-post": `/admin/displays/${String(displayId)}/layouts`,
                        "hx-vals": `{"layout_id": "${String(l.id)}"}`,
                        "hx-target": target,
                        "hx-swap": "innerHTML",
                      }}
                    >Attach</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Render the "Default Layout" select for a display. Wrapped in an out-of-band
 * htmx swap so attach/detach responses can refresh it without the rest of the
 * page. The id matches the in-page select so swap-by-id works.
 */
export function renderDefaultLayoutSelect(
  defaultLayoutId: number | null,
  attached: LayoutType[],
  oob: boolean = false,
): string {
  const oobAttr = oob ? { "hx-swap-oob": "outerHTML" } : {};
  return (
    <select id="default_layout_id" name="default_layout_id" class="form-input" {...oobAttr}>
      <option value="">-- None --</option>
      {attached.map((l) => (
        <option value={String(l.id)} selected={defaultLayoutId === l.id}>
          {l.name}
        </option>
      ))}
    </select>
  );
}

export function DisplayEditPage(props: DisplayEditPageProps) {
  const d = props.display;
  return (
    <Layout
      title={`Display: ${d.name}`}
      user={props.user}
      activeNav="displays"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <div style="max-width:600px">
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Display Info</h2>
          <div style="color:#666; font-size:0.85rem; margin-bottom:1rem">
            <div>Index: {String(d.index)}</div>
            <div>Resolution: {String(d.width_px)}x{String(d.height_px)} <span style="color:#999">(reported by kiosk)</span></div>
            <div>Power: {powerBadge(d.actual_power_state)} {d.actual_power_state_at ? <span style="color:#999">as of {formatTime(d.actual_power_state_at)}</span> : ""}</div>
            {d.kiosk_id && (
              <div>Kiosk: <a href={`/admin/kiosks/${d.kiosk_id}`}>{props.kioskName ?? `#${String(d.kiosk_id)}`}</a></div>
            )}
          </div>
          {props.attachedLayouts.length > 0 && d.kiosk_id ? (
            <div style="margin-bottom:1rem; padding:0.75rem; background:#f9fafb; border-radius:4px">
              <div style="font-size:0.85rem; font-weight:600; margin-bottom:0.5rem">Switch Layout Now</div>
              <form
                method="post"
                action={`/admin/displays/${d.id}/layout`}
                style="display:flex; gap:0.5rem; align-items:center"
                {...{
                  "hx-post": `/admin/displays/${d.id}/layout`,
                  "hx-swap": "none",
                }}
              >
                <select name="layout_id" class="form-input" style="flex:1">
                  {props.attachedLayouts.map((l) => (
                    <option value={String(l.id)}>{l.name}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  class="btn btn-sm"
                >Switch</button>
              </form>
            </div>
          ) : null}

          {d.kiosk_id ? (
            <div style="margin-bottom:1rem; display:flex; gap:0.5rem; flex-wrap:wrap">
              <button
                type="button"
                class="btn btn-sm"
                {...{
                  "hx-post": `/admin/displays/${d.id}/power/wake`,
                  "hx-swap": "none",
                }}
              >Wake Display</button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                {...{
                  "hx-post": `/admin/displays/${d.id}/power/standby`,
                  "hx-swap": "none",
                }}
              >Standby Display</button>
            </div>
          ) : null}

          <form method="post" action={`/admin/displays/${d.id}`}>
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" value={d.name} required />
            </div>

            <div class="form-group">
              <label style="display:flex; align-items:center; gap:0.5rem; cursor:pointer">
                <input
                  type="checkbox"
                  name="is_enabled"
                  value="on"
                  checked={d.is_enabled}
                />
                <span>Enabled</span>
              </label>
              <div class="form-hint">
                When disabled, the kiosk will not open a window on this display. Display stays in the list so you can re-enable it later.
              </div>
            </div>

            <div class="form-group">
              <label for="default_layout_id">Default Layout</label>
              {renderDefaultLayoutSelect(d.default_layout_id, props.attachedLayouts)}
              <div class="form-hint">
                Layout shown on idle revert. Only layouts attached below are eligible.
              </div>
            </div>

            <div class="form-group">
              <label for="idle_timeout_seconds">Idle Timeout (seconds)</label>
              <input id="idle_timeout_seconds" name="idle_timeout_seconds" type="number" class="form-input" value={String(d.idle_timeout_seconds)} min="0" />
              <div class="form-hint">Revert to default layout after this many seconds of inactivity. 0 to disable.</div>
            </div>

            <div class="form-group">
              <label for="sleep_timeout_seconds">Sleep Timeout (seconds)</label>
              <input id="sleep_timeout_seconds" name="sleep_timeout_seconds" type="number" class="form-input" value={String(d.sleep_timeout_seconds)} min="0" />
              <div class="form-hint">Send display standby after this many seconds of inactivity. 0 to disable.</div>
            </div>

            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/displays" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
          </form>
        </div>

        {/* Layout attachments */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Available Layouts</h2>
          <p style="color:#666; font-size:0.85rem; margin-bottom:1rem">
            Pick which layouts this display can show. The kiosk receives only
            attached layouts in its bundle.
          </p>

          <div id={`display-layouts-${String(d.id)}`}>
            {renderDisplayLayouts(
              d.id,
              d.default_layout_id ?? null,
              props.attachedLayouts,
              props.availableLayouts,
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}

// ---- Displays List (with clickable links) -----------------------------------

interface DisplaysPageProps {
  user: string;
  displays: Display[];
}

export function DisplaysPage(props: DisplaysPageProps) {
  return (
    <Layout title="Displays" user={props.user} activeNav="displays">
      <p style="color:#666; margin-bottom:1.25rem">Physical HDMI displays. Created automatically when kiosks are paired.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Details</th>
              <th>Power</th>
            </tr>
          </thead>
          <tbody>
            {props.displays.length === 0 ? (
              <tr><td colspan="3" style="text-align:center; color:#999; padding:2rem">None configured yet</td></tr>
            ) : (
              props.displays.map((d) => (
                <tr>
                  <td>
                    <a href={`/admin/displays/${d.id}`}><strong>{d.name}</strong></a>
                    {!d.is_enabled && (
                      <span style="margin-left:0.5rem; padding:0.1rem 0.4rem; font-size:0.7rem; background:#fee; color:#a00; border-radius:3px">disabled</span>
                    )}
                  </td>
                  <td style="color:#666">{String(d.width_px)}x{String(d.height_px)} — index {String(d.index)}</td>
                  <td>{powerBadge(d.actual_power_state)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Helpers ----------------------------------------------------------------

function parseRtspUrl(url: string): { host: string; port: string; path: string; username: string; password: string } {
  const m = url.match(/^rtsp:\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return { host: "", port: "554", path: "", username: "", password: "" };
  return {
    username: decodeURIComponent(m[1] ?? ""),
    password: decodeURIComponent(m[2] ?? ""),
    host: m[3] ?? "",
    port: m[4] ?? "554",
    path: m[5] ?? "",
  };
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---- System Health ----------------------------------------------------------

interface SystemHealthRow {
  kiosk: Kiosk;
  online: boolean;
  bundleMismatch: boolean;
  expectedBundleVersion: string | null;
  displays: Display[];
}

interface SystemHealthPageProps {
  user: string;
  rows: SystemHealthRow[];
}

function tempBadge(temp: number | null) {
  if (temp == null) return <span class="badge badge-gray">—</span>;
  const txt = `${temp.toFixed(1)}°C`;
  if (temp >= 80) return <span class="badge badge-red">{txt}</span>;
  if (temp >= 70) return <span class="badge" style="background-color:#fef3c7; color:#92400e">{txt}</span>;
  return <span class="badge badge-green">{txt}</span>;
}

function percentText(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function mbPair(used: number | null, total: number | null): string {
  if (used == null || total == null) return "—";
  return `${String(used)} / ${String(total)} MB`;
}

function powerBadge(state: Display["actual_power_state"]) {
  if (state === "awake") return <span class="badge badge-green">awake</span>;
  if (state === "standby") return <span class="badge badge-blue">standby</span>;
  return <span class="badge badge-gray">unknown</span>;
}

// ---- Node-RED Embed ---------------------------------------------------

export function NoderedEmbedPage(props: { user: string }) {
  return (
    <Layout title="Node-RED" user={props.user} activeNav="nodered">
      <div style="position:fixed; top:48px; left:220px; right:0; bottom:0; background:#fff">
        <iframe
          src="/nrdp/"
          style="width:100%; height:100%; border:none; display:block"
          {...{ "sandbox": "allow-same-origin allow-scripts allow-forms allow-popups allow-downloads" }}
        />
      </div>
    </Layout>
  );
}

export function SystemHealthPage(props: SystemHealthPageProps) {
  const total = props.rows.length;
  const online = props.rows.filter((r) => r.online).length;
  const hot = props.rows.filter((r) => r.kiosk.cpu_temp_c != null && r.kiosk.cpu_temp_c >= 70).length;
  const mismatched = props.rows.filter((r) => r.bundleMismatch).length;
  return (
    <Layout title="System Health" user={props.user} activeNav="health">
      <meta http-equiv="refresh" content="30" />
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Kiosks</div>
          <div class="stat-value">{String(total)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Online</div>
          <div class="stat-value" style={online === total ? "color:#065f46" : "color:#92400e"}>{String(online)}/{String(total)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Hot (≥70°C)</div>
          <div class="stat-value" style={hot > 0 ? "color:#b91c1c" : "color:#065f46"}>{String(hot)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bundle Mismatch</div>
          <div class="stat-value" style={mismatched > 0 ? "color:#b91c1c" : "color:#065f46"}>{String(mismatched)}</div>
        </div>
      </div>
      <p style="color:#666; margin-bottom:1rem; font-size:0.85rem">
        Auto-refresh every 30 seconds. Online = last seen within 5 minutes.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Kiosk</th>
              <th>Status</th>
              <th>Last Seen</th>
              <th>CPU Temp</th>
              <th>CPU Load</th>
              <th>RAM</th>
              <th>Disk</th>
              <th>Fan</th>
              <th>Bundle</th>
              <th>Displays</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.length === 0 ? (
              <tr><td colspan="10" style="text-align:center; color:#999; padding:2rem">No kiosks paired</td></tr>
            ) : (
              props.rows.map((row) => {
                const k = row.kiosk;
                return (
                  <tr>
                    <td><a href={`/admin/kiosks/${k.id}`}><strong>{k.name}</strong></a></td>
                    <td>
                      {row.online
                        ? <span class="badge badge-green">Online</span>
                        : <span class="badge badge-red">Offline</span>}
                    </td>
                    <td style="font-size:0.85rem; white-space:nowrap">{k.last_seen_at ? formatTime(k.last_seen_at) : "Never"}</td>
                    <td>{tempBadge(k.cpu_temp_c)}</td>
                    <td style="font-size:0.85rem">{percentText(k.cpu_load_percent)}</td>
                    <td style="font-size:0.85rem">{mbPair(k.memory_used_mb, k.memory_total_mb)}</td>
                    <td style="font-size:0.85rem">
                      {k.disk_free_mb != null && k.disk_total_mb != null
                        ? `${String(k.disk_free_mb)} MB free / ${String(k.disk_total_mb)} MB`
                        : "—"}
                      {k.disk_used_percent != null ? <span style="color:#999"> ({k.disk_used_percent.toFixed(1)}%)</span> : ""}
                    </td>
                    <td style="font-size:0.85rem">
                      {k.fan_rpm != null ? `${String(k.fan_rpm)} RPM` : "—"}
                      {k.fan_pwm != null && (
                        <span style="color:#999"> ({String(k.fan_pwm)}/255)</span>
                      )}
                    </td>
                    <td style="font-size:0.85rem">
                      {row.bundleMismatch ? (
                        <span class="badge badge-red" title={`expected ${row.expectedBundleVersion ?? "?"}, have ${k.last_bundle_version ?? "none"}`}>mismatch</span>
                      ) : k.last_bundle_version ? (
                        <span class="badge badge-green">{k.last_bundle_version.slice(0, 8)}</span>
                      ) : (
                        <span class="badge badge-gray">—</span>
                      )}
                    </td>
                    <td style="font-size:0.85rem">
                      {row.displays.length === 0 ? (
                        <span style="color:#999">none</span>
                      ) : (
                        row.displays.map((d) => (
                          <div>{d.name}: {String(d.width_px)}×{String(d.height_px)}</div>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Firmware ---------------------------------------------------------------

interface FirmwarePageProps {
  user: string;
  releases: FirmwareRelease[];
  publicKeyPem: string;
}

export function FirmwarePage(props: FirmwarePageProps) {
  return (
    <Layout title="Firmware" user={props.user} activeNav="firmware">
      <p style="color:#666; margin-bottom:1rem">
        Signed kiosk firmware artifacts. Uploaded binaries are hashed +
        Ed25519-signed by the server before kiosks can install them.
        <a href="/admin/firmware/rollouts" style="margin-left:0.5rem">Rollouts →</a>
      </p>

      <div class="card" style="margin-bottom:1.5rem">
        <h2 style="margin:0 0 1rem; font-size:1.1rem">Upload release</h2>
        <form
          method="post"
          action="/admin/firmware/upload"
          enctype="multipart/form-data"
          style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem"
        >
          <div class="form-group" style="grid-column:1/-1">
            <label for="artifact">Binary</label>
            <input id="artifact" name="artifact" type="file" required class="form-input" />
            <div class="form-hint">Stripped release binary, no archive wrapper.</div>
          </div>
          <div class="form-group">
            <label for="version">Version</label>
            <input id="version" name="version" type="text" required class="form-input" placeholder="0.4.2" />
          </div>
          <div class="form-group">
            <label for="channel">Channel</label>
            <select id="channel" name="channel" class="form-input">
              <option value="stable">stable</option>
              <option value="beta">beta</option>
              <option value="dev">dev</option>
            </select>
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label for="arch">Arch</label>
            <select id="arch" name="arch" class="form-input">
              <option value="aarch64-unknown-linux-gnu">aarch64 (Pi5)</option>
              <option value="x86_64-unknown-linux-gnu">x86_64</option>
              <option value="armv7-unknown-linux-gnueabihf">armv7</option>
            </select>
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label for="release_notes">Release notes</label>
            <textarea id="release_notes" name="release_notes" class="form-input" rows="3" />
          </div>
          <button type="submit" class="btn btn-primary" style="grid-column:1/-1">Upload + sign</button>
        </form>
      </div>

      <div class="table-wrap" style="margin-bottom:1.5rem">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Channel</th>
              <th>Arch</th>
              <th>Size</th>
              <th>SHA256</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {props.releases.length === 0 ? (
              <tr><td colspan="7" style="text-align:center; color:#999; padding:2rem">No firmware releases yet.</td></tr>
            ) : (
              props.releases.map((r) => (
                <tr style={r.yanked_at ? "opacity:0.4" : ""}>
                  <td><strong>{r.version}</strong></td>
                  <td><span class={`badge ${r.channel === "stable" ? "badge-green" : r.channel === "beta" ? "badge-yellow" : "badge-gray"}`}>{r.channel}</span></td>
                  <td style="font-family:monospace; font-size:0.8rem">{r.arch}</td>
                  <td style="font-size:0.85rem">{Math.round(r.size_bytes / 1024)} KiB</td>
                  <td style="font-family:monospace; font-size:0.75rem">{r.sha256.slice(0, 12)}…</td>
                  <td style="font-size:0.85rem; white-space:nowrap">{formatTime(r.uploaded_at)}</td>
                  <td>
                    {r.yanked_at ? (
                      <span style="color:#999; font-size:0.8rem">yanked</span>
                    ) : (
                      <button
                        type="button"
                        class="btn btn-sm btn-danger"
                        {...{
                          "hx-post": `/admin/firmware/${r.id}/yank`,
                          "hx-confirm": "Yank this release? Devices already running it stay, but no new devices will pick it up.",
                          "hx-swap": "none",
                          "hx-on::after-request": "location.reload()",
                        }}
                      >Yank</button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <details class="card" style="font-size:0.85rem">
        <summary style="cursor:pointer; font-weight:600">Signing public key</summary>
        <p style="color:#666; margin:0.5rem 0">
          Ed25519 public key kiosks pin during pairing. Safe to share. Kept here for backup.
        </p>
        <pre style="background:#fafafa; padding:0.75rem; overflow:auto; font-size:0.75rem">{props.publicKeyPem}</pre>
      </details>
    </Layout>
  );
}

interface KioskFirmwarePanelProps {
  kiosk: Kiosk;
  releases: FirmwareRelease[];
}

export function KioskFirmwarePanel(props: KioskFirmwarePanelProps) {
  const k = props.kiosk;
  const current = k.kiosk_app_version ?? "unknown";
  return (
    <div id={`kiosk-firmware-${String(k.id)}`} class="card" style="margin-bottom:1.5rem">
      <h3 style="margin:0 0 0.75rem; font-size:1rem">Firmware</h3>
      <div style="font-size:0.85rem; color:#666; margin-bottom:0.75rem">
        <div>Running: <code>{current}</code></div>
        {k.firmware_last_attempt_version && (
          <div>
            Last attempt: <code>{k.firmware_last_attempt_version}</code>
            {k.firmware_last_attempt_at && <span> at {formatTime(k.firmware_last_attempt_at)}</span>}
            {k.firmware_last_error && <span style="color:#a00"> — {k.firmware_last_error}</span>}
          </div>
        )}
      </div>
      <form
        {...{
          "hx-post": `/admin/kiosks/${String(k.id)}/firmware`,
          "hx-target": `#kiosk-firmware-${String(k.id)}`,
          "hx-swap": "outerHTML",
        }}
        style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; align-items:end"
      >
        <div class="form-group">
          <label for={`channel-${String(k.id)}`}>Channel</label>
          <select id={`channel-${String(k.id)}`} name="channel" class="form-input">
            {(["stable", "beta", "dev"] as const).map((c) => (
              <option value={c} selected={k.firmware_channel === c}>{c}</option>
            ))}
          </select>
        </div>
        <div class="form-group">
          <label for={`target-${String(k.id)}`}>Pin to version</label>
          <select id={`target-${String(k.id)}`} name="target_version" class="form-input">
            <option value="">-- follow channel --</option>
            {props.releases.filter((r) => !r.yanked_at).map((r) => (
              <option value={r.version} selected={k.firmware_target_version === r.version}>
                {r.version} ({r.channel}, {r.arch})
              </option>
            ))}
          </select>
        </div>
        <div style="grid-column:1/-1; display:flex; gap:0.5rem">
          <button type="submit" class="btn btn-primary">Save</button>
          <button
            type="button"
            class="btn"
            {...{
              "hx-post": `/admin/kiosks/${String(k.id)}/firmware/push`,
              "hx-swap": "none",
            }}
          >Push update now</button>
        </div>
      </form>
    </div>
  );
}

// ---- Kiosk local-server panel (LAN GET API + admin proxy) ------------------

interface KioskLocalPanelProps { kiosk: Kiosk }

interface ReportedNetworkInterface {
  name: string;
  mac?: string | null;
  operstate?: string | null;
  ips: string[];
}

function parseReportedNetworkInterfaces(raw: string | null): ReportedNetworkInterface[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      name: typeof item?.name === "string" ? item.name : "unknown",
      mac: typeof item?.mac === "string" ? item.mac : null,
      operstate: typeof item?.operstate === "string" ? item.operstate : null,
      ips: Array.isArray(item?.ips) ? item.ips.filter((ip: unknown) => typeof ip === "string") : [],
    })).filter((item) => item.ips.length > 0);
  } catch {
    return [];
  }
}

function ipWithoutCidr(ip: string): string {
  return ip.includes("/") ? ip.slice(0, ip.indexOf("/")) : ip;
}

function isUsableLanIp(ip: string): boolean {
  const bare = ipWithoutCidr(ip);
  return bare !== "::1" && !bare.startsWith("127.") && !bare.startsWith("169.254.");
}

export function KioskLocalPanel(props: KioskLocalPanelProps) {
  const k = props.kiosk;
  if (!k.local_key || !k.local_port) return "";
  const reportedInterfaces = parseReportedNetworkInterfaces(k.network_interfaces_json);
  const reportedIps = reportedInterfaces.flatMap((iface) => iface.ips);
  const primaryReportedIp = reportedIps.find(isUsableLanIp);
  const ip = primaryReportedIp ? ipWithoutCidr(primaryReportedIp) : (k.local_last_ip || "<kiosk-ip>");
  const base = `http://${ip}:${String(k.local_port)}`;
  const sample = `${base}/local/layout/<layout_id>?key=${k.local_key}`;
  const proxy = `${base}/proxy/admin/...`;
  return (
    <div class="card" style="margin-bottom:1.5rem">
      <h3 style="margin:0 0 0.5rem; font-size:1rem">Local LAN endpoints</h3>
      <p style="font-size:0.8rem; color:#666; margin:0 0 0.75rem">
        Kiosk runs an HTTP listener on its own LAN address. Bookmark-friendly
        GET URLs trigger layout switches without needing an admin session.
      </p>
      <div style="font-size:0.8rem; margin-bottom:0.5rem">
        <strong>Layout switch (GET):</strong>
        <pre style="background:#fafafa; padding:0.5rem; margin:0.25rem 0; font-size:0.75rem; white-space:pre-wrap; word-break:break-all">{sample}</pre>
      </div>
      <div style="font-size:0.8rem; margin-bottom:0.5rem">
        <strong>Admin proxy (forwards your Bearer to server):</strong>
        <pre style="background:#fafafa; padding:0.5rem; margin:0.25rem 0; font-size:0.75rem; white-space:pre-wrap">{proxy}</pre>
      </div>
      {k.reported_hostname || reportedInterfaces.length > 0 ? (
        <div style="font-size:0.8rem; margin-bottom:0.5rem">
          {k.reported_hostname ? <div><strong>Reported hostname:</strong> <code>{k.reported_hostname}</code></div> : null}
          {reportedInterfaces.length > 0 ? (
            <div style="margin-top:0.35rem">
              <strong>Reported interfaces:</strong>
              <ul style="margin:0.25rem 0 0; padding-left:1.25rem">
                {reportedInterfaces.map((iface) => (
                  <li>
                    <code>{iface.name}</code>
                    {iface.operstate ? <> ({iface.operstate})</> : null}
                    {": "}
                    {iface.ips.map((ipAddr, idx) => (
                      <>
                        {idx > 0 ? ", " : ""}
                        <code>{ipAddr}</code>
                      </>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      <div style="font-size:0.75rem; color:#999">
        Heartbeat source IP: <code>{k.local_last_ip ?? "--"}</code>. Local key:
        <code style="margin-left:0.25rem">{k.local_key.slice(0, 8)}…{k.local_key.slice(-4)}</code>
      </div>
    </div>
  );
}

// ---- Firmware rollouts -----------------------------------------------------

interface FirmwareRolloutsPageProps {
  user: string;
  rollouts: FirmwareRollout[];
  releases: FirmwareRelease[];
  kiosks: Kiosk[];
}

export function FirmwareRolloutsPage(props: FirmwareRolloutsPageProps) {
  const releaseById = new Map(props.releases.map((r) => [r.id, r]));
  const kioskById = new Map(props.kiosks.map((k) => [k.id, k]));
  return (
    <Layout title="Firmware rollouts" user={props.user} activeNav="kiosks">
      <p style="color:#666; margin-bottom:1rem">
        Push a specific release to a slice of the fleet. <code>percentage</code>
        buckets kiosks deterministically by id, so re-running a 50% rollout
        with the same targets touches the same half.
      </p>

      <div class="card" style="margin-bottom:1.5rem">
        <h2 style="margin:0 0 1rem; font-size:1.1rem">New rollout</h2>
        <form method="post" action="/admin/firmware/rollouts/new"
              style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem">
          <div class="form-group">
            <label for="release_id">Release</label>
            <select id="release_id" name="release_id" class="form-input" required>
              <option value="">--</option>
              {props.releases.filter((r) => !r.yanked_at).map((r) => (
                <option value={r.id}>{r.version} · {r.channel} · {r.arch}</option>
              ))}
            </select>
          </div>
          <div class="form-group">
            <label for="percentage">Percentage</label>
            <input id="percentage" name="percentage" type="number" min="1" max="100" value="100" class="form-input" />
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label for="target_kiosk_ids">Targets (leave empty = all kiosks on release channel)</label>
            <select id="target_kiosk_ids" name="target_kiosk_ids" class="form-input" multiple size="6">
              {props.kiosks.map((k) => (
                <option value={String(k.id)}>{k.name} (#{String(k.id)})</option>
              ))}
            </select>
            <div class="form-hint">Cmd/Ctrl-click to multi-select. Or post a comma-separated id list via API.</div>
          </div>
          <button type="submit" class="btn btn-primary" style="grid-column:1/-1">Create + activate</button>
        </form>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Release</th>
              <th>State</th>
              <th>%</th>
              <th>Targets</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {props.rollouts.length === 0 ? (
              <tr><td colspan="6" style="text-align:center; color:#999; padding:2rem">No rollouts yet.</td></tr>
            ) : (
              props.rollouts.map((r) => {
                const rel = releaseById.get(r.release_id);
                const targetCount = r.target_kiosk_ids.length;
                const targetSummary = targetCount === 0
                  ? "(all on channel)"
                  : r.target_kiosk_ids.slice(0, 3).map((id) => kioskById.get(id)?.name ?? `#${String(id)}`).join(", ")
                    + (targetCount > 3 ? ` +${String(targetCount - 3)} more` : "");
                return (
                  <tr>
                    <td><strong>{rel?.version ?? r.release_id}</strong>{rel && <span style="color:#999"> ({rel.channel}/{rel.arch})</span>}</td>
                    <td><span class={`badge ${r.state === "active" ? "badge-green" : r.state === "paused" ? "badge-yellow" : r.state === "complete" ? "badge-gray" : "badge-blue"}`}>{r.state}</span></td>
                    <td>{String(r.percentage)}%</td>
                    <td style="font-size:0.85rem">{targetSummary}</td>
                    <td style="font-size:0.85rem; white-space:nowrap">{formatTime(r.created_at)}</td>
                    <td>
                      <form method="post" action={`/admin/firmware/rollouts/${r.id}/state`} style="display:inline">
                        <input type="hidden" name="state" value={r.state === "paused" ? "active" : "paused"} />
                        <button type="submit" class="btn btn-sm" style="margin-right:0.25rem">
                          {r.state === "paused" ? "Resume" : "Pause"}
                        </button>
                      </form>
                      <form method="post" action={`/admin/firmware/rollouts/${r.id}/state`} style="display:inline">
                        <input type="hidden" name="state" value="complete" />
                        <button type="submit" class="btn btn-sm btn-danger">Complete</button>
                      </form>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Audit log -------------------------------------------------------------

interface AuditLogPageProps {
  user: string;
  entries: AuditEntry[];
  filterAction?: string;
  filterActorType?: string;
}

export function AuditLogPage(props: AuditLogPageProps) {
  return (
    <Layout title="Audit log" user={props.user} activeNav="audit">
      <p style="color:#666; margin-bottom:1rem">
        Append-only record of admin + kiosk + system actions. Most recent first.
      </p>
      <form method="get" action="/admin/audit" style="display:flex; gap:0.5rem; margin-bottom:1rem">
        <input type="text" name="action" placeholder="action prefix (e.g. firmware.)"
               value={props.filterAction ?? ""} class="form-input" />
        <select name="actor_type" class="form-input" style="max-width:200px">
          <option value="" selected={!props.filterActorType}>any actor</option>
          {(["user", "api_key", "kiosk", "system"] as const).map((t) => (
            <option value={t} selected={props.filterActorType === t}>{t}</option>
          ))}
        </select>
        <button type="submit" class="btn">Filter</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th><th>Result</th><th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {props.entries.length === 0 ? (
              <tr><td colspan="7" style="text-align:center; color:#999; padding:2rem">No entries.</td></tr>
            ) : (
              props.entries.map((e) => (
                <tr>
                  <td style="font-size:0.8rem; white-space:nowrap">{formatTime(e.ts)}</td>
                  <td style="font-size:0.85rem">
                    <span class="badge badge-gray">{e.actor_type}</span>
                    {e.actor_label && <span style="margin-left:0.25rem">{e.actor_label}</span>}
                  </td>
                  <td style="font-family:monospace; font-size:0.8rem">{e.action}</td>
                  <td style="font-size:0.85rem">{e.resource_type ? `${e.resource_type}#${e.resource_id ?? ""}` : ""}</td>
                  <td style="font-size:0.8rem">{e.ip ?? ""}</td>
                  <td>
                    <span class={`badge ${e.result === "ok" ? "badge-green" : "badge-red"}`}>{e.result}</span>
                  </td>
                  <td style="font-size:0.75rem; font-family:monospace; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title={JSON.stringify(e.metadata)}>
                    {Object.keys(e.metadata).length === 0 ? "" : JSON.stringify(e.metadata)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---- Backup / restore -------------------------------------------------------

interface BackupPageProps {
  user: string;
  error?: string;
  success?: string;
}

export function BackupPage(props: BackupPageProps) {
  return (
    <Layout title="Backup & restore" user={props.user} activeNav="backup"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <p style="color:#666; margin-bottom:1rem">
        Encrypted snapshot of the SQLite DB + master secret + firmware signing
        key. Passphrase protects the file (AES-256-GCM, PBKDF2 200k). Lose
        the passphrase = lose the backup. Firmware binaries are excluded.
      </p>

      <div class="two-col">
        <div class="card">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Download backup</h2>
          <form method="post" action="/admin/backup/download">
            <div class="form-group">
              <label for="dl_pass">Passphrase</label>
              <input id="dl_pass" name="passphrase" type="password" minlength="8" required class="form-input" />
              <div class="form-hint">Min 8 chars. Store somewhere safe.</div>
            </div>
            <button type="submit" class="btn btn-primary">Download .bfbak</button>
          </form>
        </div>

        <div class="card">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Restore from backup</h2>
          <form method="post" action="/admin/backup/restore" enctype="multipart/form-data">
            <div class="form-group">
              <label for="blob">Backup file (.bfbak)</label>
              <input id="blob" name="blob" type="file" required class="form-input" />
            </div>
            <div class="form-group">
              <label for="rs_pass">Passphrase</label>
              <input id="rs_pass" name="passphrase" type="password" required class="form-input" />
            </div>
            <div style="background:#fee; border:1px solid #fcc; padding:0.5rem; font-size:0.85rem; margin-bottom:0.75rem">
              <strong>Warning:</strong> overwrites DB and master keys.
              Restart the server immediately after restore.
            </div>
            <button type="submit" class="btn btn-danger">Restore</button>
          </form>
        </div>
      </div>
    </Layout>
  );
}
