/**
 * Admin page templates: overview, cameras, kiosks, account, etc.
 */
import { js } from "jsx-htmx";
import { Layout } from "./layout.js";
import type {
  Camera,
  Display,
  Kiosk,
  Label,
  Layout as LayoutType,
  LayoutCell,
  LayoutRegion,
  LayoutTemplate,
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
        <form method="post" action="/admin/cameras/new">
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
            <label>Type</label>
            <div class="radio-group">
              <label>
                <input type="radio" name="type" value="rtsp" checked={v["type"] !== "onvif"} />
                RTSP
              </label>
              <label>
                <input type="radio" name="type" value="onvif" checked={v["type"] === "onvif"} />
                ONVIF
              </label>
            </div>
          </div>

          <div id="rtsp-fields">
            <div class="form-group">
              <label for="rtsp_url">RTSP URL</label>
              <input
                id="rtsp_url"
                name="rtsp_url"
                type="url"
                class="form-input"
                placeholder="rtsp://192.168.1.100:554/stream1"
                value={v["rtsp_url"] ?? ""}
              />
            </div>
          </div>

          <div id="onvif-fields" style="display:none">
            <div class="form-group">
              <label for="onvif_host">ONVIF Host</label>
              <input id="onvif_host" name="onvif_host" type="text" class="form-input" value={v["onvif_host"] ?? ""} />
            </div>
            <div class="form-group">
              <label for="onvif_port">Port</label>
              <input id="onvif_port" name="onvif_port" type="number" class="form-input" value={v["onvif_port"] ?? "80"} />
            </div>
            <div class="form-group">
              <label for="onvif_username">Username</label>
              <input id="onvif_username" name="onvif_username" type="text" class="form-input" value={v["onvif_username"] ?? ""} />
            </div>
            <div class="form-group">
              <label for="onvif_password">Password</label>
              <input id="onvif_password" name="onvif_password" type="password" class="form-input" />
            </div>
          </div>

          <button type="submit" class="btn btn-primary">Add Camera</button>
          <a href="/admin/cameras" class="btn btn-ghost" style="margin-left:0.5rem">Cancel</a>
        </form>
      </div>

      <script>{js(
        `(function(){` +
        `var radios=document.querySelectorAll('input[name="type"]');` +
        `var rd=document.getElementById("rtsp-fields");` +
        `var od=document.getElementById("onvif-fields");` +
        `function t(){var el=document.querySelector('input[name="type"]:checked');` +
        `var v=el?el.value:"rtsp";` +
        `if(rd)rd.style.display=v==="rtsp"?"block":"none";` +
        `if(od)od.style.display=v==="onvif"?"block":"none";}` +
        `radios.forEach(function(r){r.addEventListener("change",t)});t();})()`
      )}</script>
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
            {cam.type === "rtsp" && (
              <div class="form-group">
                <label for="rtsp_url">RTSP URL</label>
                <input id="rtsp_url" name="rtsp_url" type="text" class="form-input" value={cam.rtsp_url ?? ""} />
              </div>
            )}
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

// ---- Templates (Layout Templates) -------------------------------------------

interface TemplatesPageProps {
  user: string;
  templates: LayoutTemplate[];
}

export function TemplatesPage(props: TemplatesPageProps) {
  return (
    <Layout title="Layout Templates" user={props.user} activeNav="templates">
      <div class="section-header">
        <h2 class="section-title">All Templates</h2>
        <a href="/admin/templates/new" class="btn btn-primary">New Template</a>
      </div>
      <p style="color:#666; margin-bottom:1.25rem">
        Templates define named regions on a grid. Layouts bind content into these regions.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Grid</th>
              <th>Regions</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {props.templates.length === 0 ? (
              <tr><td colspan="4" style="text-align:center; color:#999; padding:2rem">No templates created yet</td></tr>
            ) : (
              props.templates.map((t) => (
                <tr>
                  <td><a href={`/admin/templates/${t.id}`}><strong>{t.name}</strong></a></td>
                  <td>{String(t.grid_cols)}x{String(t.grid_rows)}</td>
                  <td>{String(t.regions.length)} region{t.regions.length !== 1 ? "s" : ""}</td>
                  <td>
                    {t.is_builtin
                      ? <span class="badge badge-gray">Built-in</span>
                      : <span class="badge badge-blue">Custom</span>
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

// ---- Template New -----------------------------------------------------------

interface TemplateNewPageProps {
  user: string;
  error?: string;
  values?: Record<string, string>;
}

export function TemplateNewPage(props: TemplateNewPageProps) {
  const v = props.values ?? {};
  return (
    <Layout
      title="New Template"
      user={props.user}
      activeNav="templates"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <div style="max-width:700px">
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Choose a Preset</h2>
          <p style="color:#666; margin-bottom:1rem; font-size:0.85rem">
            Pick a preset to get started quickly, or choose Custom to define your own regions.
          </p>
          <div class="stats-grid" style="margin-bottom:0">
            <form method="post" action="/admin/templates/new" style="margin:0">
              <input type="hidden" name="preset" value="fullscreen" />
              <input type="hidden" name="name" value="Fullscreen" />
              <button type="submit" class="card" style="width:100%; text-align:left; cursor:pointer; border:1px solid #d0d0d0; background:#fff">
                <strong>Fullscreen</strong>
                <div style="color:#666; font-size:0.8rem">1x1 grid, single region</div>
              </button>
            </form>
            <form method="post" action="/admin/templates/new" style="margin:0">
              <input type="hidden" name="preset" value="2x2" />
              <input type="hidden" name="name" value="2x2 Grid" />
              <button type="submit" class="card" style="width:100%; text-align:left; cursor:pointer; border:1px solid #d0d0d0; background:#fff">
                <strong>2x2 Grid</strong>
                <div style="color:#666; font-size:0.8rem">4 equal regions</div>
              </button>
            </form>
            <form method="post" action="/admin/templates/new" style="margin:0">
              <input type="hidden" name="preset" value="1plus3" />
              <input type="hidden" name="name" value="1+3" />
              <button type="submit" class="card" style="width:100%; text-align:left; cursor:pointer; border:1px solid #d0d0d0; background:#fff">
                <strong>1+3</strong>
                <div style="color:#666; font-size:0.8rem">Large left, 3 stacked right</div>
              </button>
            </form>
            <form method="post" action="/admin/templates/new" style="margin:0">
              <input type="hidden" name="preset" value="3x3" />
              <input type="hidden" name="name" value="3x3 Grid" />
              <button type="submit" class="card" style="width:100%; text-align:left; cursor:pointer; border:1px solid #d0d0d0; background:#fff">
                <strong>3x3 Grid</strong>
                <div style="color:#666; font-size:0.8rem">9 equal regions</div>
              </button>
            </form>
          </div>
        </div>

        <div class="card">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Custom Template</h2>
          <form method="post" action="/admin/templates/new">
            <input type="hidden" name="preset" value="custom" />
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" required maxlength="128" value={v["name"] ?? ""} />
            </div>
            <div class="form-group">
              <label for="grid_cols">Grid Columns</label>
              <input id="grid_cols" name="grid_cols" type="number" class="form-input" min="1" max="12" value={v["grid_cols"] ?? "12"} />
            </div>
            <div class="form-group">
              <label for="grid_rows">Grid Rows</label>
              <input id="grid_rows" name="grid_rows" type="number" class="form-input" min="1" max="12" value={v["grid_rows"] ?? "12"} />
            </div>
            <div class="form-group">
              <label for="regions">Regions (JSON)</label>
              <textarea
                id="regions"
                name="regions"
                class="form-input"
                rows="6"
                placeholder={'[\n  { "name": "main", "row": 0, "col": 0, "rowSpan": 12, "colSpan": 12 }\n]'}
              >{v["regions"] ?? ""}</textarea>
              <div class="form-hint">
                Array of regions: name, row, col, rowSpan, colSpan. Grid is zero-indexed.
              </div>
            </div>
            <button type="submit" class="btn btn-primary">Create Template</button>
            <a href="/admin/templates" class="btn btn-ghost" style="margin-left:0.5rem">Cancel</a>
          </form>
        </div>
      </div>
    </Layout>
  );
}

// ---- Template Edit ----------------------------------------------------------

interface TemplateEditPageProps {
  user: string;
  template: LayoutTemplate;
  error?: string;
  success?: string;
}

export function TemplateEditPage(props: TemplateEditPageProps) {
  const t = props.template;
  return (
    <Layout
      title={`Template: ${t.name}`}
      user={props.user}
      activeNav="templates"
      flash={
        props.error ? { type: "error", message: props.error }
        : props.success ? { type: "success", message: props.success }
        : undefined
      }
    >
      <div style="max-width:700px">
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Edit Template</h2>
          <form method="post" action={`/admin/templates/${t.id}`}>
            <div class="form-group">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" class="form-input" value={t.name} required maxlength="128" />
            </div>
            <div class="form-group">
              <label for="description">Description</label>
              <input id="description" name="description" type="text" class="form-input" value={t.description ?? ""} />
            </div>
            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/templates" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
          </form>
        </div>

        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Grid: {String(t.grid_cols)}x{String(t.grid_rows)}</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Position</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {t.regions.length === 0 ? (
                  <tr><td colspan="3" style="text-align:center; color:#999; padding:1rem">No regions defined</td></tr>
                ) : (
                  t.regions.map((r) => (
                    <tr>
                      <td><strong>{r.name}</strong></td>
                      <td>row {String(r.row)}, col {String(r.col)}</td>
                      <td>{String(r.rowSpan)}x{String(r.colSpan)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Visual grid preview */}
        {t.regions.length > 0 && (
          <div class="card" style="margin-bottom:1.5rem">
            <h2 style="margin:0 0 1rem; font-size:1.1rem">Preview</h2>
            <div style={`display:grid; grid-template-columns:repeat(${String(t.grid_cols)}, 1fr); grid-template-rows:repeat(${String(t.grid_rows)}, 30px); gap:2px; background:#e5e7eb; padding:2px; border-radius:4px`}>
              {t.regions.map((r) => (
                <div style={`grid-column:${String(r.col + 1)} / span ${String(r.colSpan)}; grid-row:${String(r.row + 1)} / span ${String(r.rowSpan)}; background:#dbeafe; display:flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:600; color:#1e40af; border-radius:2px`}>
                  {r.name}
                </div>
              ))}
            </div>
          </div>
        )}

        {!t.is_builtin && (
          <form method="post" action={`/admin/templates/${t.id}/delete`} style="margin-top:1rem">
            <button type="submit" class="btn btn-danger" {...{"onclick": "return confirm('Delete this template? Layouts using it will break.')"}}>Delete Template</button>
          </form>
        )}
      </div>
    </Layout>
  );
}

// ---- Layouts ----------------------------------------------------------------

interface LayoutsPageProps {
  user: string;
  layouts: LayoutType[];
  templates: Map<number, LayoutTemplate>;
  displays: Map<number, Display>;
}

export function LayoutsPage(props: LayoutsPageProps) {
  return (
    <Layout title="Layouts" user={props.user} activeNav="layouts">
      <div class="section-header">
        <h2 class="section-title">All Layouts</h2>
        <a href="/admin/layouts/new" class="btn btn-primary">New Layout</a>
      </div>
      <p style="color:#666; margin-bottom:1.25rem">
        A layout binds cameras and other content into a template's regions for one display.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Template</th>
              <th>Display</th>
              <th>Priority</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {props.layouts.length === 0 ? (
              <tr><td colspan="5" style="text-align:center; color:#999; padding:2rem">No layouts created yet</td></tr>
            ) : (
              props.layouts.map((l) => {
                const tmpl = props.templates.get(l.template_id);
                const disp = props.displays.get(l.display_id);
                return (
                  <tr>
                    <td><a href={`/admin/layouts/${l.id}`}><strong>{l.name}</strong></a></td>
                    <td>{tmpl ? tmpl.name : `#${String(l.template_id)}`}</td>
                    <td>{disp ? disp.name : `#${String(l.display_id)}`}</td>
                    <td>
                      {l.priority === "hot"
                        ? <span class="badge badge-red">hot</span>
                        : l.priority === "cold"
                          ? <span class="badge badge-blue">cold</span>
                          : <span class="badge badge-gray">normal</span>
                      }
                    </td>
                    <td>
                      {l.is_default ? <span class="badge badge-green">Yes</span> : ""}
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
  templates: LayoutTemplate[];
  displays: Display[];
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
        <form method="post" action="/admin/layouts/new">
          <div class="form-group">
            <label for="name">Layout Name</label>
            <input id="name" name="name" type="text" class="form-input" required maxlength="128" value={v["name"] ?? ""} />
          </div>

          <div class="form-group">
            <label for="template_id">Template</label>
            <select id="template_id" name="template_id" class="form-input" required>
              <option value="">-- Select Template --</option>
              {props.templates.map((t) => (
                <option value={String(t.id)} selected={v["template_id"] === String(t.id)}>
                  {t.name} ({String(t.grid_cols)}x{String(t.grid_rows)}, {String(t.regions.length)} regions)
                </option>
              ))}
            </select>
            {props.templates.length === 0 && (
              <div class="form-hint">
                No templates exist. <a href="/admin/templates/new">Create one first</a>.
              </div>
            )}
          </div>

          <div class="form-group">
            <label for="display_id">Display</label>
            <select id="display_id" name="display_id" class="form-input" required>
              <option value="">-- Select Display --</option>
              {props.displays.map((d) => (
                <option value={String(d.id)} selected={v["display_id"] === String(d.id)}>
                  {d.name} ({String(d.width_px)}x{String(d.height_px)})
                </option>
              ))}
            </select>
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
            <label for="description">Description (optional)</label>
            <input id="description" name="description" type="text" class="form-input" value={v["description"] ?? ""} />
          </div>

          <div class="form-group">
            <label>
              <input type="checkbox" name="is_default" value="1" checked={v["is_default"] === "1"} />
              {" "}Set as default layout for this display
            </label>
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
    </Layout>
  );
}

// ---- Layout Edit ------------------------------------------------------------

interface LayoutEditPageProps {
  user: string;
  layout: LayoutType;
  template: LayoutTemplate;
  display: Display;
  cells: LayoutCell[];
  cameras: Camera[];
  error?: string;
  success?: string;
}

export function LayoutEditPage(props: LayoutEditPageProps) {
  const l = props.layout;
  const t = props.template;
  // Build a map from region_name → cell for easy lookup
  const cellByRegion = new Map<string, LayoutCell>();
  for (const c of props.cells) {
    cellByRegion.set(c.region_name, c);
  }
  // Also build camera name lookup
  const cameraById = new Map<number, Camera>();
  for (const cam of props.cameras) {
    cameraById.set(cam.id, cam);
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
      <div style="max-width:800px">
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
                <input type="checkbox" name="is_default" value="1" checked={l.is_default} />
                {" "}Default layout for display
              </label>
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
            <div>Template: <a href={`/admin/templates/${t.id}`}>{t.name}</a> ({String(t.grid_cols)}x{String(t.grid_rows)})</div>
            <div>Display: <a href={`/admin/displays/${props.display.id}`}>{props.display.name}</a></div>
          </div>
        </div>

        {/* Template preview with cell assignments */}
        {t.regions.length > 0 && (
          <div class="card" style="margin-bottom:1.5rem">
            <h2 style="margin:0 0 1rem; font-size:1.1rem">Grid Preview</h2>
            <div style={`display:grid; grid-template-columns:repeat(${String(t.grid_cols)}, 1fr); grid-template-rows:repeat(${String(t.grid_rows)}, 40px); gap:2px; background:#e5e7eb; padding:2px; border-radius:4px`}>
              {t.regions.map((r) => {
                const cell = cellByRegion.get(r.name);
                let label = r.name;
                let bgColor = "#f9fafb";
                let textColor = "#666";
                if (cell) {
                  bgColor = "#dbeafe";
                  textColor = "#1e40af";
                  if (cell.content_type === "camera" && cell.camera_id) {
                    const cam = cameraById.get(cell.camera_id);
                    label = cam ? cam.name : `cam #${String(cell.camera_id)}`;
                  } else if (cell.content_type === "web") {
                    label = "Web";
                  } else if (cell.content_type === "html") {
                    label = "HTML";
                  }
                }
                return (
                  <div style={`grid-column:${String(r.col + 1)} / span ${String(r.colSpan)}; grid-row:${String(r.row + 1)} / span ${String(r.rowSpan)}; background:${bgColor}; display:flex; align-items:center; justify-content:center; font-size:0.7rem; font-weight:600; color:${textColor}; border-radius:2px; overflow:hidden; text-overflow:ellipsis; padding:0 4px`}>
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Cell assignments table */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Cell Assignments</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Content</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {t.regions.map((r) => {
                  const cell = cellByRegion.get(r.name);
                  return (
                    <tr>
                      <td><strong>{r.name}</strong></td>
                      <td>
                        {cell ? (
                          <span>
                            <span class="badge badge-blue">{cell.content_type}</span>
                            {" "}
                            {cell.content_type === "camera" && cell.camera_id
                              ? (cameraById.get(cell.camera_id)?.name ?? `#${String(cell.camera_id)}`)
                              : cell.content_type === "web" && cell.web_url
                                ? <span style="font-size:0.8rem; color:#666">{cell.web_url}</span>
                                : cell.content_type === "html"
                                  ? <span style="font-size:0.8rem; color:#666">(custom HTML)</span>
                                  : ""
                            }
                          </span>
                        ) : (
                          <span style="color:#999">Empty</span>
                        )}
                      </td>
                      <td>
                        {cell && (
                          <form method="post" action={`/admin/layouts/${l.id}/cells/${cell.id}/delete`} style="display:inline">
                            <button type="submit" class="btn btn-sm btn-danger" {...{"onclick": "return confirm('Remove this cell?')"}}>Remove</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Add cell form */}
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="margin:0 0 1rem; font-size:1.1rem">Assign Content to Region</h2>
          <form method="post" action={`/admin/layouts/${l.id}/cells`}>
            <div class="form-group">
              <label for="region_name">Region</label>
              <select id="region_name" name="region_name" class="form-input" required>
                <option value="">-- Select Region --</option>
                {t.regions.map((r) => {
                  const taken = cellByRegion.has(r.name);
                  return (
                    <option value={r.name} disabled={taken}>
                      {r.name}{taken ? " (assigned)" : ""}
                    </option>
                  );
                })}
              </select>
            </div>

            <div class="form-group">
              <label for="content_type">Content Type</label>
              <select id="content_type" name="content_type" class="form-input" required>
                <option value="camera">Camera</option>
                <option value="web">Web URL</option>
                <option value="html">HTML</option>
              </select>
            </div>

            <div id="camera-fields">
              <div class="form-group">
                <label for="camera_id">Camera</label>
                <select id="camera_id" name="camera_id" class="form-input">
                  <option value="">-- Select Camera --</option>
                  {props.cameras.map((cam) => (
                    <option value={String(cam.id)}>{cam.name}</option>
                  ))}
                </select>
              </div>
              <div class="form-group">
                <label for="stream_selector">Stream</label>
                <select id="stream_selector" name="stream_selector" class="form-input">
                  <option value="auto">Auto</option>
                  <option value="main">Main</option>
                  <option value="sub">Sub</option>
                </select>
              </div>
            </div>

            <div id="web-fields" style="display:none">
              <div class="form-group">
                <label for="web_url">URL</label>
                <input id="web_url" name="web_url" type="url" class="form-input" placeholder="https://example.com" />
              </div>
            </div>

            <div id="html-fields" style="display:none">
              <div class="form-group">
                <label for="html_content">HTML Content</label>
                <textarea id="html_content" name="html_content" class="form-input" rows="4" placeholder="<div>...</div>"></textarea>
              </div>
            </div>

            <button type="submit" class="btn btn-primary">Assign</button>
          </form>
        </div>

        <script>{js(
          `(function(){` +
          `var sel=document.getElementById("content_type");` +
          `var cf=document.getElementById("camera-fields");` +
          `var wf=document.getElementById("web-fields");` +
          `var hf=document.getElementById("html-fields");` +
          `function t(){var v=sel?sel.value:"camera";` +
          `if(cf)cf.style.display=v==="camera"?"block":"none";` +
          `if(wf)wf.style.display=v==="web"?"block":"none";` +
          `if(hf)hf.style.display=v==="html"?"block":"none";}` +
          `if(sel)sel.addEventListener("change",t);t();})()`
        )}</script>

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
  layouts: LayoutType[];
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
            <div>Resolution: {String(d.width_px)}x{String(d.height_px)}</div>
            <div>Primary: {d.is_primary ? "Yes" : "No"}</div>
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
                {props.layouts.map((l) => (
                  <option value={String(l.id)} selected={d.default_layout_id === l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <div class="form-hint">Layout shown on idle revert.</div>
            </div>

            <div class="form-group">
              <label for="idle_timeout_seconds">Idle Timeout (seconds)</label>
              <input id="idle_timeout_seconds" name="idle_timeout_seconds" type="number" class="form-input" value={String(d.idle_timeout_seconds)} min="0" />
              <div class="form-hint">Revert to default layout after this many seconds of inactivity. 0 to disable.</div>
            </div>

            <div class="form-group">
              <label for="sleep_timeout_seconds">Sleep Timeout (seconds)</label>
              <input id="sleep_timeout_seconds" name="sleep_timeout_seconds" type="number" class="form-input" value={String(d.sleep_timeout_seconds)} min="0" />
              <div class="form-hint">Send CEC standby after this many seconds of inactivity. 0 to disable.</div>
            </div>

            <div class="form-group">
              <label for="width_px">Width (px)</label>
              <input id="width_px" name="width_px" type="number" class="form-input" value={String(d.width_px)} min="1" />
            </div>

            <div class="form-group">
              <label for="height_px">Height (px)</label>
              <input id="height_px" name="height_px" type="number" class="form-input" value={String(d.height_px)} min="1" />
            </div>

            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/admin/displays" class="btn btn-ghost" style="margin-left:0.5rem">Back</a>
          </form>
        </div>

        {props.layouts.length > 0 && (
          <div class="card">
            <h2 style="margin:0 0 1rem; font-size:1.1rem">Layouts on This Display</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Priority</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  {props.layouts.map((l) => (
                    <tr>
                      <td><a href={`/admin/layouts/${l.id}`}><strong>{l.name}</strong></a></td>
                      <td><span class={`badge ${l.priority === "hot" ? "badge-red" : l.priority === "cold" ? "badge-blue" : "badge-gray"}`}>{l.priority}</span></td>
                      <td>{l.is_default ? <span class="badge badge-green">Yes</span> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
      <p style="color:#666; margin-bottom:1.25rem">Physical HDMI displays. Primary display created during setup.</p>
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
