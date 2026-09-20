# Demo mode and new-display defaults

Demo is disabled by default. Set `BF_ENABLE_DEMO_TENANT=true` in the Docker deployment and restart the server. Native deployments set `enableDemoTenant: true` in both `service-api-http` and `service-admin-http` configuration in `sec-config.yaml`.

On first enablement the server creates a reserved `demo` tenant in the root tenant registry, with a welcome layout and that layout selected as its display default. It never adopts an existing tenant with that slug. If provisioning fails, demo is not advertised. Subsequent starts preserve administrator edits. Platform administrators can switch into Demo through the normal tenant menu to edit content. Demo disappears from administration when disabled; existing kiosks remain subject to cleanup.

Under **Settings → New display layouts**, each tenant can select layouts to automatically assign to newly created displays, and optionally select one of those layouts as the default active layout. This also applies to displays discovered later. Defaults do not modify existing displays or restore assignments removed by an administrator. Deleted layouts are ignored.

## Client and reviewer path

1. Start an unpaired Android/Android TV, Linux, or Windows kiosk against the enabled server.
2. Choose **Demo** at the top left of the pairing screen. No account or administrator approval is required.
3. Normal pairing completes and the assigned demo layout starts playing.
4. Choose **Exit demo** at the top left to clear local enrollment and content/session state and return to startup. Exit does not call a server deletion endpoint. On Linux this uses the existing supervised kiosk restart.

The initial pairing response includes `allowDemo`; clients only show the entry control when it is explicitly true. `POST /api/pair/demo` accepts only `code` and `polling_secret` from that pairing session. The endpoint confirms normal pairing into the server-owned demo tenant; clients retrieve and acknowledge their individual credentials through the existing claim endpoints. It is disabled when demo is unavailable, requires the polling secret, rate limits requests, and respects the demo tenant kiosk limit (initially 1,000). A claimed response carries `demo: true` so clients retain their Exit demo control across restarts.

A server job checks once per minute, deleting at most 100 demo kiosks per pass. A kiosk becomes eligible when **either** it reaches 24 hours since pairing **or** its last heartbeat was at least five minutes ago. Before its first heartbeat, pairing time is used. Normal kiosk deletion behavior applies; shared layouts and the demo tenant remain. The cleanup continues when new demo enrollment is disabled.

Demo does not change application, firmware, OS, or store update policies. Only intentionally public content should be placed in the demo tenant.
