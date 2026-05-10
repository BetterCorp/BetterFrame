/**
 * Base HTML layout for all admin pages.
 * Server-side rendered via jsx-htmx — returns string.
 */
import { css, js } from "jsx-htmx";

// ---- Shared types -----------------------------------------------------------

export interface PageProps {
  title: string;
  /** Username shown in navbar; omit for unauthenticated pages. */
  user?: string;
  /** If true, hide the sidebar nav (used for login/setup). */
  minimal?: boolean;
  /** Optional flash message. */
  flash?: { type: "success" | "error" | "info"; message: string };
  /** Active nav item key. */
  activeNav?: string;
  children?: string | string[];
}

// ---- Components -------------------------------------------------------------

function NavItem(props: { href: string; label: string; icon: string; active?: boolean }) {
  return (
    <a
      href={props.href}
      class={`nav-item${props.active ? " active" : ""}`}
    >
      <span class="nav-icon">{props.icon}</span>
      {props.label}
    </a>
  );
}

function Sidebar(props: { activeNav?: string }) {
  const a = props.activeNav;
  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <strong>BetterFrame</strong>
      </div>
      <nav class="sidebar-nav">
        <NavItem href="/admin/" label="Overview" icon="&#9632;" active={a === "overview"} />
        <NavItem href="/admin/cameras" label="Cameras" icon="&#9899;" active={a === "cameras"} />
        <NavItem href="/admin/layouts" label="Layouts" icon="&#9638;" active={a === "layouts"} />
        <NavItem href="/admin/templates" label="Templates" icon="&#9641;" active={a === "templates"} />
        <NavItem href="/admin/displays" label="Displays" icon="&#9642;" active={a === "displays"} />
        <NavItem href="/admin/kiosks" label="Kiosks" icon="&#9672;" active={a === "kiosks"} />
        <NavItem href="/admin/labels" label="Labels" icon="&#9670;" active={a === "labels"} />
        <hr />
        <NavItem href="/admin/account" label="Account" icon="&#9679;" active={a === "account"} />
        <NavItem href="/nrdp/" label="Node-RED" icon="&#8594;" />
      </nav>
    </aside>
  );
}

// ---- Layout -----------------------------------------------------------------

export function Layout(props: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} — BetterFrame</title>
        <link rel="stylesheet" href="/static/app.css" />
        <style>{css(baseStyles as Parameters<typeof css>[0])}</style>
      </head>
      <body class={props.minimal ? "minimal" : "has-sidebar"}>
        {!props.minimal && <Sidebar activeNav={props.activeNav} />}
        <div class="main-wrap">
          {!props.minimal && props.user && (
            <header class="topbar">
              <span class="topbar-title">{props.title}</span>
              <div class="topbar-right">
                <span class="topbar-user">{props.user}</span>
                <form method="post" action="/auth/logout" style="display:inline">
                  <button type="submit" class="btn btn-sm btn-ghost">Logout</button>
                </form>
              </div>
            </header>
          )}
          {props.flash && (
            <div class={`flash flash-${props.flash.type}`}>{props.flash.message}</div>
          )}
          <main class="content">{props.children}</main>
        </div>
        <script src="/static/htmx.min.js"></script>
      </body>
    </html>
  );
}

/** Minimal centered layout for login/setup pages. */
export function MinimalLayout(props: { title: string; flash?: PageProps["flash"]; children?: string | string[] }) {
  return (
    <Layout title={props.title} minimal flash={props.flash}>
      <div class="center-card">
        <div class="card">
          <h1 class="card-title">{props.title}</h1>
          {props.children}
        </div>
      </div>
    </Layout>
  );
}

// ---- Styles -----------------------------------------------------------------

const baseStyles = {
  "*, *::before, *::after": { boxSizing: "border-box" as const },
  body: {
    margin: "0",
    fontFamily: "system-ui, -apple-system, sans-serif",
    backgroundColor: "#f4f5f7",
    color: "#1a1a2e",
    fontSize: "14px",
    lineHeight: "1.5",
  },
  "a": { color: "#2563eb", textDecoration: "none" },
  "a:hover": { textDecoration: "underline" },
  ".has-sidebar": { display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" },
  ".sidebar": {
    backgroundColor: "#1a1a2e",
    color: "#e0e0e0",
    display: "flex",
    flexDirection: "column",
    position: "sticky" as const,
    top: "0",
    height: "100vh",
    overflowY: "auto" as const,
  },
  ".sidebar-brand": { padding: "1.25rem 1rem", fontSize: "1.1rem", borderBottom: "1px solid #2a2a4e" },
  ".sidebar-nav": { padding: "0.5rem 0", display: "flex", flexDirection: "column", gap: "2px" },
  ".nav-item": {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 1rem",
    color: "#c0c0d0",
    textDecoration: "none",
    fontSize: "0.875rem",
    borderRadius: "0",
  },
  ".nav-item:hover": { backgroundColor: "#2a2a4e", color: "#fff", textDecoration: "none" },
  ".nav-item.active": { backgroundColor: "#2563eb", color: "#fff" },
  ".nav-icon": { fontSize: "0.75rem", width: "1.25rem", textAlign: "center" as const },
  ".sidebar hr": { border: "none", borderTop: "1px solid #2a2a4e", margin: "0.5rem 0" },
  ".topbar": {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.75rem 1.5rem",
    backgroundColor: "#fff",
    borderBottom: "1px solid #e0e0e0",
  },
  ".topbar-title": { fontWeight: "600", fontSize: "1rem" },
  ".topbar-right": { display: "flex", alignItems: "center", gap: "0.75rem" },
  ".topbar-user": { color: "#666", fontSize: "0.85rem" },
  ".main-wrap": { display: "flex", flexDirection: "column", minHeight: "100vh" },
  ".content": { flex: "1", padding: "1.5rem" },
  ".minimal .content": { display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" },
  ".center-card": { width: "100%", maxWidth: "420px" },
  ".card": {
    backgroundColor: "#fff",
    borderRadius: "8px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    padding: "1.5rem",
  },
  ".card-title": { margin: "0 0 1.25rem", fontSize: "1.25rem", fontWeight: "600" },
  ".form-group": { marginBottom: "1rem" },
  ".form-group label": { display: "block", marginBottom: "0.25rem", fontWeight: "500", fontSize: "0.85rem" },
  ".form-input": {
    width: "100%",
    padding: "0.5rem 0.75rem",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    fontSize: "0.9rem",
    backgroundColor: "#fff",
  },
  ".form-input:focus": { outline: "none", borderColor: "#2563eb", boxShadow: "0 0 0 2px rgba(37,99,235,0.15)" },
  ".form-hint": { fontSize: "0.8rem", color: "#666", marginTop: "0.25rem" },
  ".form-error": { fontSize: "0.8rem", color: "#dc2626", marginTop: "0.25rem" },
  ".btn": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.5rem 1rem",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    fontSize: "0.9rem",
    fontWeight: "500",
    textDecoration: "none",
    gap: "0.5rem",
  },
  ".btn-primary": { backgroundColor: "#2563eb", color: "#fff" },
  ".btn-primary:hover": { backgroundColor: "#1d4ed8" },
  ".btn-danger": { backgroundColor: "#dc2626", color: "#fff" },
  ".btn-danger:hover": { backgroundColor: "#b91c1c" },
  ".btn-ghost": { backgroundColor: "transparent", color: "#666", border: "1px solid #d0d0d0" },
  ".btn-ghost:hover": { backgroundColor: "#f0f0f0" },
  ".btn-sm": { padding: "0.25rem 0.5rem", fontSize: "0.8rem" },
  ".btn-block": { width: "100%", justifyContent: "center" },
  ".flash": { padding: "0.75rem 1rem", borderRadius: "4px", marginBottom: "1rem", fontSize: "0.9rem" },
  ".flash-success": { backgroundColor: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7" },
  ".flash-error": { backgroundColor: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5" },
  ".flash-info": { backgroundColor: "#dbeafe", color: "#1e40af", border: "1px solid #93c5fd" },
  ".stats-grid": { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "1.5rem" },
  ".stat-card": { backgroundColor: "#fff", borderRadius: "8px", padding: "1.25rem", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  ".stat-label": { fontSize: "0.8rem", color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
  ".stat-value": { fontSize: "1.75rem", fontWeight: "700", marginTop: "0.25rem" },
  ".table-wrap": { backgroundColor: "#fff", borderRadius: "8px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  table: { width: "100%", borderCollapse: "collapse" as const },
  "th, td": { textAlign: "left" as const, padding: "0.75rem 1rem", borderBottom: "1px solid #eee" },
  th: { backgroundColor: "#f9fafb", fontWeight: "600", fontSize: "0.8rem", textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "#666" },
  "tr:hover td": { backgroundColor: "#f9fafb" },
  ".badge": { display: "inline-block", padding: "0.15rem 0.5rem", borderRadius: "12px", fontSize: "0.75rem", fontWeight: "500" },
  ".badge-green": { backgroundColor: "#d1fae5", color: "#065f46" },
  ".badge-gray": { backgroundColor: "#e5e7eb", color: "#374151" },
  ".badge-blue": { backgroundColor: "#dbeafe", color: "#1e40af" },
  ".badge-red": { backgroundColor: "#fee2e2", color: "#991b1b" },
  ".section-header": { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" },
  ".section-title": { fontSize: "1rem", fontWeight: "600", margin: "0" },
  ".radio-group": { display: "flex", gap: "1rem", marginBottom: "0.5rem" },
  ".radio-group label": { display: "flex", alignItems: "center", gap: "0.35rem", fontWeight: "400", cursor: "pointer" },
  ".two-col": { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" },
  "@media (max-width: 768px)": { ".two-col": { gridTemplateColumns: "1fr" } },
  ".code-grid": { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0.5rem", fontFamily: "monospace", fontSize: "1rem" },
  ".code-item": { padding: "0.5rem", backgroundColor: "#f9fafb", borderRadius: "4px", textAlign: "center" as const },
};
