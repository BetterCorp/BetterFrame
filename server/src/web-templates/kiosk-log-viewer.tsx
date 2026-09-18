import { Layout, LocalTime } from "./layout.js";
import { logViewUrl, type LogFilters, type LogPage } from "../shared/kiosk-log-view.js";

// jsx-htmx deliberately does not escape text children by default.
const escapeText = (value: string) => value.replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[char]!);

export function KioskLogViewer(props: {
  user: string; kiosk?: {id: string; name: string}; devices: Array<{id: string; name: string}>;
  filters: LogFilters; page: LogPage;
}) {
  const { filters, page, kiosk } = props;
  const base = kiosk ? `/admin/kiosks/${encodeURIComponent(kiosk.id)}/diagnostics` : "/admin/logs";
  const latest = new URL(logViewUrl(base, filters), "http://localhost");
  latest.searchParams.delete("until");
  const last = page.logs.at(-1);
  return <Layout title={kiosk ? `Logs: ${escapeText(kiosk.name)}` : "Logs"} user={escapeText(props.user)} activeNav="logs">
    <link rel="stylesheet" href="/static/kiosk-logs.css" />
    <section class="log-viewer" aria-label="Diagnostic logs">
      <a class="log-mobile-home" href="/admin/">← Overview</a>
      <div class="log-heading">
        <div><h1>{kiosk ? escapeText(kiosk.name) : "All kiosks"} <span class="log-muted">/ Logs</span></h1>
          <p class="log-muted">OS and application diagnostics · current tenant</p></div>
        <div class="log-actions">
          {kiosk ? <><a class="btn btn-ghost" href={`/admin/kiosks/${encodeURIComponent(kiosk.id)}`}>Kiosk</a><a class="btn btn-ghost" href="/admin/logs">All kiosk logs</a></> : null}
          <a class="btn btn-primary" href={`${latest.pathname}${latest.search}`}>Refresh latest</a>
        </div>
      </div>
      <form method="get" action={base} class="log-filters">
        <label class="log-search">Search message or context<input type="search" name="q" class="form-input" value={filters.search} maxlength="256" placeholder="Error, process, boot ID…" /></label>
        {!kiosk ? <label>Kiosk<select class="form-input" name="kiosk">
          <option value="">All kiosks</option>
          {props.devices.map(device => <option value={device.id} selected={device.id === filters.kiosk_id}>{escapeText(device.name)}</option>)}
        </select></label> : null}
        <label>Severity<select class="form-input" name="level"><option value="">All levels</option>
          {["error", "warn", "info", "debug"].map(level => <option value={level} selected={level === filters.level}>{level}</option>)}
        </select></label>
        <label>Source<select class="form-input" name="source"><option value="">All sources</option>
          <option value="os" selected={filters.source === "os"}>OS journal</option><option value="app" selected={filters.source === "app"}>Application</option>
        </select></label>
        <label>Received from (UTC)<input class="form-input" type="datetime-local" step="0.001" name="from" value={filters.from?.replace(/Z$/, "") ?? ""} /></label>
        <label>Received through (UTC)<input class="form-input" type="datetime-local" step="0.001" name="until" value={filters.until.replace(/Z$/, "")} /></label>
        <label>Page size<select class="form-input" name="limit">{[50, 100, 200].map(size => <option value={String(size)} selected={size === filters.limit}>{size}</option>)}</select></label>
        <div class="log-actions log-filter-actions"><button class="btn btn-primary" type="submit">Apply filters</button><a class="btn btn-ghost" href={base}>Reset</a></div>
      </form>
      <div class="log-toolbar">
        <span>{page.logs.length} events on this page{page.hasMore ? " · more available" : ""}</span>
        <label><input type="checkbox" data-log-wrap checked /> Wrap long lines</label>
        <button class="btn btn-sm btn-ghost" type="button" data-log-collapse>Collapse all</button>
      </div>
      <div class="log-list" role="region" aria-label="Log entries">
        <div class="log-columns" aria-hidden="true"><span>Event time</span><span>Severity</span><span>Kiosk / source</span><span>Message</span></div>
        {page.logs.map(log => <details class="log-entry" data-log-url={`/admin/logs/${encodeURIComponent(log.id)}`}>
          <summary class="log-row">
            <span class="log-time"><LocalTime value={log.logged_at} format="event" /></span>
            <span class={`log-level log-level-${log.level}`}>{log.level}</span>
            <span class="log-device"><strong>{escapeText(log.kiosk_name)}</strong><small>{log.source === "os" ? "OS" : log.source === "app" ? "App" : "Other"}{log.unit ? ` · ${escapeText(log.unit)}` : ""}</small></span>
            <span class="log-message-preview"><span class="log-excerpt">{escapeText(log.preview.replace(/\r?\n/g, " ↵ "))}</span>
              <small>{log.lines > 1 ? `${log.lines} lines · ` : ""}{log.characters.toLocaleString("en-US")} chars <span aria-hidden="true">⌄</span></small></span>
          </summary>
          <div class="log-detail" aria-live="polite"><p class="log-muted">Loading details…</p></div>
        </details>)}
        {!page.logs.length ? <div class="log-empty"><h2>No matching logs</h2><p>Change the filters or refresh to check for new uploads.</p></div> : null}
      </div>
      <div class="log-pagination">
        <span class="log-muted">Newest received first. Opening an entry shows its complete message and context.</span>
        <div class="log-actions">
          {filters.before ? <a class="btn btn-ghost" href={logViewUrl(base, filters)}>First page</a> : null}
          {page.hasMore && last ? <a class="btn btn-primary" rel="next" href={logViewUrl(base, filters, {time: last.cursor_time, id: last.id})}>Older logs →</a> : null}
        </div>
      </div>
      <p data-log-status class="log-muted" role="status"></p>
    </section>
    <script src="/static/kiosk-logs.js" defer></script>
  </Layout>;
}
