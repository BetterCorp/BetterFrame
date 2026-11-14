import { Layout, LocalTime } from "./layout.js";
import { escapeOverlayAttribute as esc } from "../shared/overlays.js";
import { trustedCaRevision, type TrustedCa, type TrustedCaStatus } from "../shared/trusted-cas.js";
import type { Kiosk } from "../shared/types.js";

export function TrustedCasPage(props: { user?: string; error?: string; cas: TrustedCa[]; kiosks: Kiosk[];
  assignments: Array<{ kiosk_id: string; ca_id: string }>;
  reports: Array<TrustedCaStatus & { kiosk_id: string; reported_at: string }> }) {
  return <Layout title="Trusted certificate authorities" activeNav="trusted-cas" user={props.user}>
    <p>Trust a private certificate authority on selected players so they can display your internal HTTPS sites.</p>
    <p>Certificates apply to the player’s system or user trust store and may also affect other applications. Only public, self-signed CA certificates are accepted.</p>
    {props.error ? <p role="alert">{esc(props.error)}</p> : ""}
    <section class="card"><h2>Add a CA certificate</h2>
      <form method="post" action="/admin/trusted-cas" enctype="multipart/form-data">
        <div class="form-group"><label for="ca-name">Name</label><input id="ca-name" name="name" class="form-input" required maxlength="128" /></div>
        <div class="form-group"><label for="ca-file">Certificate (PEM or DER, up to 16 KiB)</label><input id="ca-file" name="certificate" type="file" accept=".pem,.crt,.cer,.der" required /></div>
        <button class="btn btn-primary" type="submit">Add certificate</button>
      </form>
    </section>
    <h2>Certificate library</h2>
    {props.cas.length ? <div class="table-wrap"><table><thead><tr><th>Name / subject</th><th>SHA-256 fingerprint</th><th>Expires</th><th>Actions</th></tr></thead><tbody>
      {props.cas.map(ca => <tr><td>{esc(ca.name)}<br /><small>{esc(ca.subject)}</small></td><td><code style="overflow-wrap:anywhere">{ca.fingerprint_sha256}</code></td>
        <td><LocalTime value={ca.not_after} /></td><td><a class="btn" href={`/admin/trusted-cas/${ca.id}/certificate`}>Download</a>
        <form method="post" action={`/admin/trusted-cas/${ca.id}/delete`}><button class="btn btn-danger" type="submit">Delete and unassign</button></form></td></tr>)}
    </tbody></table></div> : <p>No CA certificates have been added.</p>}
    <h2>Player assignments</h2>
    <p>Save an empty selection to remove BetterFrame-installed certificates. Changes apply when the player next connects. Older players need an app update.</p>
    <p>Windows automatic provisioning requires an elevated BetterFrame agent and applies to all users on that player. Unelevated agents require manual certificate installation.</p>
    <p>Managed Android players install automatically. On other Android devices, download the assigned certificate and install it through Android Settings → Security → Encryption &amp; credentials → Install a CA certificate. Removal also requires Settings on those devices.</p>
    {props.kiosks.map(kiosk => {
      const assigned = props.assignments.filter(a => a.kiosk_id === kiosk.id).map(a => a.ca_id);
      const desired = trustedCaRevision(props.cas.filter(ca => assigned.includes(ca.id)));
      const report = props.reports.find(r => r.kiosk_id === kiosk.id);
      const state = !report ? "Awaiting player report" : report.revision !== desired ? "Pending assignment change" : report.state === "applied" ? "Applied" : report.state === "manual_action" ? "Manual action required" : report.state === "error" ? "Error" : "Pending";
      return <section class="card"><h3>{esc(kiosk.name)}</h3><p role="status">{state}{report ? <span> · <LocalTime value={report.reported_at} /></span> : ""}</p>
        {report?.message ? <p>{esc(report.message)}</p> : ""}
        <form method="post" action={`/admin/trusted-cas/players/${kiosk.id}`}>
          {props.cas.map(ca => <label style="display:block"><input type="checkbox" name="ca_ids" value={ca.id} checked={assigned.includes(ca.id)} /> {esc(ca.name)}</label>)}
          <button class="btn btn-primary" type="submit">Save player certificates</button>
        </form>
      </section>;
    }).join("")}
  </Layout>;
}
