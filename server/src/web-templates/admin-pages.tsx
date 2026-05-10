/**
 * Admin page templates: overview, cameras, kiosks, account, etc.
 */
import { js } from "jsx-htmx";
import { Layout } from "./layout.js";
import type { Camera, Kiosk, PairingCode, EventLog } from "../shared/types.js";

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
                  <td><strong>{cam.name}</strong></td>
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
                      <td><strong>{k.name}</strong></td>
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
