/**
 * Admin page templates: overview, cameras, kiosks, account, etc.
 */
import { js } from "jsx-htmx";
import { Layout } from "./layout.js";
import type {
  Camera,
  Display,
  Entity,
  Kiosk,
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
  const cls = type === "camera" ? "badge-blue" : type === "web" ? "badge-green" : "badge-gray";
  return <span class={`badge ${cls}`}>{type}</span>;
}

function entityDetail(e: Entity): string {
  if (e.type === "camera") return e.camera_id ? `cam #${String(e.camera_id)}` : "—";
  if (e.type === "web") return e.web_url ?? "—";
  if (e.type === "html") return e.html_content ? `${e.html_content.slice(0, 80)}…` : "—";
  return "—";
}

export function EntitiesPage(props: EntitiesPageProps) {
  return (
    <Layout title="Entities" user={props.user} activeNav="entities">
      <div class="section-header">
        <h2 class="section-title">All Entities</h2>
        <a href="/admin/entities/new" class="btn btn-primary">New Entity</a>
      </div>
      <p style="color:#666; margin-bottom:1.25rem">
        Entities are reusable content blocks (a camera reference, an HTML
        snippet, or a web page). Bind one entity to any number of layout cells —
        edit the entity once and every cell updates.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {props.entities.length === 0 ? (
              <tr><td colspan="3" style="text-align:center; color:#999; padding:2rem">No entities yet</td></tr>
            ) : (
              props.entities.map((e) => (
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

            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/entities" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
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
                <label for="name_override">Name Override (optional)</label>
                <input id="name_override" name="name_override" type="text" class="form-input" />
              </div>
              <div class="form-group">
                <label for="initial_labels">Initial Labels (optional)</label>
                <input id="initial_labels" name="initial_labels" type="text" class="form-input" placeholder="lobby, floor-1" />
                <div class="form-hint">Comma-separated label names.</div>
              </div>
              <button type="submit" class="btn btn-primary btn-block">Pair Kiosk</button>
            </form>

            {props.pendingCodes.length > 0 && (
              <div style="margin-top:1.25rem; border-top:1px solid #eee; padding-top:1rem">
                <div style="font-weight:600; font-size:0.85rem; margin-bottom:0.5rem">Pending Codes</div>
                {props.pendingCodes.map((pc) => (
                  <div style="display:flex; justify-content:space-between; font-size:0.85rem; padding:0.25rem 0">
                    <code>{pc.code}</code>
                    <span style="color:#666">{formatTime(pc.expires_at)}</span>
                  </div>
                ))}
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
              <tr><td colspan="2" style="text-align:center; color:#999; padding:2rem">None configured yet</td></tr>
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
          {props.labels.length > 0 ? (
            <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem">
              {props.labels.map((l) => (
                <form method="post" action={`/admin/cameras/${cam.id}/labels/remove`} style="display:inline">
                  <input type="hidden" name="label_id" value={String(l.label_id)} />
                  <button type="submit" class="badge badge-blue" style="cursor:pointer; border:none" title="Click to remove">
                    {l.name} ×
                  </button>
                </form>
              ))}
            </div>
          ) : (
            <p style="color:#999; margin-bottom:1rem">No labels attached</p>
          )}
          <form method="post" action={`/admin/cameras/${cam.id}/labels`} style="display:flex; gap:0.5rem">
            <select name="label_id" class="form-input" style="flex:1">
              {props.allLabels
                .filter((al) => !props.labels.some((l) => l.label_id === al.id))
                .map((al) => <option value={String(al.id)}>{al.name}</option>)}
            </select>
            <button type="submit" class="btn btn-primary">Add</button>
          </form>
          <form method="post" action={`/admin/cameras/${cam.id}/labels`} style="display:flex; gap:0.5rem; margin-top:0.5rem">
            <input name="new_label" type="text" class="form-input" placeholder="Or create new label..." style="flex:1" />
            <button type="submit" class="btn btn-ghost">Create &amp; Add</button>
          </form>
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
  error?: string;
  success?: string;
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
            <form method="post" action={`/admin/kiosks/${k.id}/power/wake`} style="display:inline">
              <button type="submit" class="btn btn-sm">Wake</button>
            </form>
            <form method="post" action={`/admin/kiosks/${k.id}/power/standby`} style="display:inline; margin-left:0.5rem">
              <button type="submit" class="btn btn-sm btn-ghost">Standby</button>
            </form>
          </div>

          <div style="margin-top:1rem; padding-top:1rem; border-top:1px solid #eee">
            <div style="font-size:0.85rem; font-weight:600; margin-bottom:0.5rem">Hardware</div>
            <div style="display:flex; gap:1.5rem; flex-wrap:wrap; font-size:0.85rem; color:#666; margin-bottom:0.75rem">
              <div>CPU: {k.cpu_temp_c != null ? `${k.cpu_temp_c.toFixed(1)}°C` : "—"}</div>
              <div>Fan: {k.fan_rpm != null ? `${k.fan_rpm} RPM` : "—"}</div>
              <div>PWM: {k.fan_pwm != null ? `${k.fan_pwm}/255` : "—"}</div>
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap">
              <form method="post" action={`/admin/kiosks/${k.id}/fan`} style="display:inline">
                <input type="hidden" name="mode" value="auto" />
                <button type="submit" class="btn btn-sm btn-ghost">Auto</button>
              </form>
              <form method="post" action={`/admin/kiosks/${k.id}/fan`} style="display:inline">
                <input type="hidden" name="pwm" value="0" />
                <button type="submit" class="btn btn-sm btn-ghost">Off</button>
              </form>
              <form method="post" action={`/admin/kiosks/${k.id}/fan`} style="display:inline">
                <input type="hidden" name="pwm" value="128" />
                <button type="submit" class="btn btn-sm btn-ghost">50%</button>
              </form>
              <form method="post" action={`/admin/kiosks/${k.id}/fan`} style="display:inline">
                <input type="hidden" name="pwm" value="255" />
                <button type="submit" class="btn btn-sm btn-ghost">Full</button>
              </form>
            </div>
          </div>
        </div>

        {/* Associated displays */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Displays</h2>
          {props.displays && props.displays.length > 0 ? (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Resolution</th><th>Index</th></tr></thead>
                <tbody>
                  {props.displays.map((d) => (
                    <tr>
                      <td><a href={`/admin/displays/${d.id}`}><strong>{d.name}</strong></a></td>
                      <td>{String(d.width_px)}x{String(d.height_px)}</td>
                      <td>{String(d.index)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style="color:#999">No displays associated with this kiosk</p>
          )}
        </div>

        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Labels</h2>
          {props.labels.length > 0 ? (
            <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem">
              {props.labels.map((l) => (
                <form method="post" action={`/admin/kiosks/${k.id}/labels/remove`} style="display:inline">
                  <input type="hidden" name="label_id" value={String(l.label_id)} />
                  <button type="submit" class="badge badge-blue" style="cursor:pointer; border:none" title="Click to remove">
                    {l.name} ({l.role}) ×
                  </button>
                </form>
              ))}
            </div>
          ) : (
            <p style="color:#999; margin-bottom:1rem">No labels attached</p>
          )}
          <form method="post" action={`/admin/kiosks/${k.id}/labels`} style="display:flex; gap:0.5rem">
            <select name="label_id" class="form-input" style="flex:1">
              {props.allLabels
                .filter((al) => !props.labels.some((l) => l.label_id === al.id))
                .map((al) => <option value={String(al.id)}>{al.name}</option>)}
            </select>
            <select name="role" class="form-input" style="width:120px">
              <option value="consume">consume</option>
              <option value="operate">operate</option>
            </select>
            <button type="submit" class="btn btn-primary">Add</button>
          </form>
          <form method="post" action={`/admin/kiosks/${k.id}/labels`} style="display:flex; gap:0.5rem; margin-top:0.5rem">
            <input name="new_label" type="text" class="form-input" placeholder="Or create new label..." style="flex:1" />
            <select name="role" class="form-input" style="width:120px">
              <option value="consume">consume</option>
              <option value="operate">operate</option>
            </select>
            <button type="submit" class="btn btn-ghost">Create &amp; Add</button>
          </form>
        </div>

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
            {d.kiosk_id && (
              <div>Kiosk: <a href={`/admin/kiosks/${d.kiosk_id}`}>{props.kioskName ?? `#${String(d.kiosk_id)}`}</a></div>
            )}
          </div>
          <form method="post" action={`/admin/displays/${d.id}`}>
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" value={d.name} required />
            </div>

            <div class="form-group">
              <label for="default_layout_id">Default Layout</label>
              <select id="default_layout_id" name="default_layout_id" class="form-input">
                <option value="">-- None --</option>
                {props.attachedLayouts.map((l) => (
                  <option value={String(l.id)} selected={d.default_layout_id === l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
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

          {props.attachedLayouts.length === 0 ? (
            <p style="color:#999; margin-bottom:1rem">No layouts attached yet.</p>
          ) : (
            <div class="table-wrap" style="margin-bottom:1rem">
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
                  {props.attachedLayouts.map((l) => (
                    <tr>
                      <td><a href={`/admin/layouts/${l.id}`}><strong>{l.name}</strong></a></td>
                      <td><span class={`badge ${l.priority === "hot" ? "badge-red" : l.priority === "cold" ? "badge-blue" : "badge-gray"}`}>{l.priority}</span></td>
                      <td>{d.default_layout_id === l.id ? <span class="badge badge-green">Yes</span> : ""}</td>
                      <td>
                        <form method="post" action={`/admin/displays/${d.id}/layouts/${l.id}/remove`} style="display:inline">
                          <button type="submit" class="btn btn-sm btn-danger" {...{"onclick": "return confirm('Detach this layout from the display?')"}}>Detach</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {props.availableLayouts.length > 0 ? (
            <form method="post" action={`/admin/displays/${d.id}/layouts`} style="display:flex; gap:0.5rem">
              <select name="layout_id" class="form-input" style="flex:1" required>
                <option value="">-- Pick a layout to attach --</option>
                {props.availableLayouts.map((l) => (
                  <option value={String(l.id)}>{l.name}</option>
                ))}
              </select>
              <button type="submit" class="btn btn-primary">Attach</button>
            </form>
          ) : (
            <p style="color:#999; font-size:0.85rem; margin:0">
              {props.attachedLayouts.length === 0
                ? <span>No layouts exist yet. <a href="/admin/layouts/new">Create one</a>.</span>
                : "All existing layouts are already attached."}
            </p>
          )}
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
            </tr>
          </thead>
          <tbody>
            {props.displays.length === 0 ? (
              <tr><td colspan="2" style="text-align:center; color:#999; padding:2rem">None configured yet</td></tr>
            ) : (
              props.displays.map((d) => (
                <tr>
                  <td><a href={`/admin/displays/${d.id}`}><strong>{d.name}</strong></a></td>
                  <td style="color:#666">{String(d.width_px)}x{String(d.height_px)} — index {String(d.index)}</td>
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
