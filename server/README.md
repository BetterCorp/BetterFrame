
### Android viewer contract

Android clients pair with the `android-viewer` capability (and versioned
`android-viewer-v1`). Their bundle contains one enabled display, assigned layouts,
resolved enabled camera entities and playback credentials. Operator content,
GPIO, ONVIF credentials/callbacks, preloads and scripted login secrets are excluded.
Smart URL cells retain an empty marker so clients can show an unsupported tile.
Only local expand/restore and assigned-layout click actions survive filtering.

The native API permits bundle, heartbeat, logs and `POST /api/kiosk/display-session`.
Pairing remains on the existing `/api/pair/*` routes. No enabled display or no
assigned layouts returns `409 {"error":"display_unassigned"}`; the app must discard
cached content immediately and keep polling with its paired identity. `401` means
invalid/disabled identity. Management, update, event and cloud camera credential
endpoints are unavailable to this profile. The WebSocket permits reload, ping and
currently assigned layout switches; assignment is checked again before delivery.

`POST /api/kiosk/display-session` requires the native Bearer key and returns a
one-hour HttpOnly, SameSite=Strict cookie scoped to `/dash/`. Install its Set-Cookie
using Android CookieManager for the BF origin, and renew before expiry. Never put
the native kiosk key in a WebView. Angie must overwrite `X-Original-URI` on its
`/api/kiosk/_check` auth subrequest. Each cookie check revalidates the tenant,
enabled kiosk, key fingerprint and current dashboard assignment. HTTPS adds the
Secure cookie flag; HTTP is for explicitly configured LAN deployments.

Assigned dashboard pages and shared `/dash/assets/` resources can authenticate.
**FlowFuse `/dash/socket.io` is denied:** its shared room transport does not yet
enforce the viewer's dashboard assignment. Dynamic BF dashboards that require this
transport are unavailable until the provider implements room-level authorization;
do not fall back to a full kiosk-key cookie. Generic webpages, HTML and external
signage use their existing content authentication and remain supported.
