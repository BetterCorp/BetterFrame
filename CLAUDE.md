# BetterFrame — handoff

> Format: dense, structured. Update on every meaningful decision.
> A future Claude reading this fresh should be able to continue without re-deciding.
> Updated: 2026-05-08

## product
- name: **BetterFrame** · multi-camera display system, Pi-5-first
- org: BetterCorp (user-affiliated). Prefer their packages where applicable.
- env prefix `BETTERFRAME_*` · cookie `betterframe_session` · api-key prefix `bf-`
- headers `X-BetterFrame-*` · totp issuer `BetterFrame`
- db `betterframe.db` · paths `/var/lib/betterframe`, `/etc/betterframe`

## goals
- ≤32 cams/display
- mixed cells: camera | web | html
- **layout swap = zero perceived latency** (driving constraint → kiosk needs decoder pool)
- camera config: raw rtsp OR onvif (auto-discover)
- API-key admin API + username/pw+TOTP admin UI
- single-host AND distributed installs from same artifact
- offline-tolerant: kiosk runs cached bundle if server down

## arch (current)
```
[cameras]─RTSP→[kiosk: rust+gtk4+gstreamer; cec/gpio/onvif-sub local]
                       ↑ws (port 18082) + bundle pull (port 18081)
[admin]─https→[angie proxy]
                ├→/admin/* /api/* /s/*  → service-admin-http (h3, port 18080)
                ├→/api/kiosk/* /api/pair/* → service-api-http (h3, port 18081)
                ├→/ws/kiosk           → service-coordinator-ws (port 18082)
                ├→/nrdp/* /dash/*      → node-red (1880)
                ├→/in/public/*         → node-red (rate-limited)
                └→/in/kiosk/*          → node-red (kiosk-key gated)
              ↓
        [BSB runtime] (Node.js ≥23) — sec-config.yaml drives everything
        Plugins:
          service-store         (sqlite, single writer; node:sqlite built-in)
          service-secrets       (fernet-equivalent + cluster key)
          service-auth          (passwords/totp/sessions/api-keys)
          service-admin-http    (h3 listener, htmx admin UI via jsx-htmx)
          service-api-http      (h3 listener, kiosk-facing REST)
          service-coordinator-ws (ws server for live kiosk channel)
          service-pairing       (8-char code state machine)
          service-bundle        (label-aware bundle generation)
          service-nodered-bridge (HTTP forwarder both ways)
          service-cec-relay     (commands → authoritative kiosk)
        ↕ BSB event bus (events-default in-memory; swap to RabbitMQ later if needed)
```

## stack & languages
- **TS / Node.js ≥23** — server. BSB v9 framework. h3 v2 for HTTP. node:sqlite built-in. argon2 + otpauth for crypto/totp. jsx-htmx for SSR.
- **TS** — Node-RED custom nodes (`bf-*`).
- **Browser JS (ESM)** — htmx + tiny anyvali-driven form helper. Vendored, no build step.
- **Rust** — kiosk app. GTK4 + GStreamer. Imports anyvali schemas exported from server.
- **Bash** — vendor scripts, eventually a `bf` CLI.

## key decisions (chronological + WHY)
1. **kiosk = native rust+gtk4+gstreamer**. pi5 chromium has no hw h264 decode; we own decoder pool. zero-latency swap needs warm pipelines.
2. **stream warmth**: hot/warm/cooling/cold per (cam,stream-type). layouts declare needed+preload. cooling timeout per layout AND cell. `priority:hot` always warm.
3. **stream selection**: cells ≥20% display→main, else sub. per-cam `stream_policy: auto|always_main|always_sub`. per-cell selector overrides.
4. **layout templates** = 12×12 named regions; layouts bind cells→region names.
5. **two timeouts**: idle (revert to default layout) vs sleep (CEC standby). per-layout `resets_idle_timer:bool`.
6. **CEC** via `cec-ctl` (v4l-utils), NOT libcec. async subprocess. **kiosk side** (kiosk owns hdmi).
7. **multi-display ready** but v1 = index 0. all api carries display_id.
8. **node-red owns ALL rules**. dropped the py engine plan. `event_log` table kept.
9. **shortlinks live in node-red**, not our db.
10. **3 auth tiers** at proxy via `auth_request`:
    - public `/in/public/*` `/s/*` — rate-limited
    - kiosk-key `/api/kiosk/*` `/in/kiosk/*` `/dash/*` (kiosks)
    - admin session+TOTP `/admin/*` `/api/admin/*` `/nrdp/*` `/dash/*` (humans)
11. **labels** = routing primitive. cams+layouts+kiosks carry labels. 2 binding kinds:
    - `consume`: any kiosk w/label may render
    - `operate`: exactly ONE kiosk authoritative (composite PK incl role)
12. **cluster key** (single shared symmetric) for cam-pw delivery to kiosks.
13. **kiosk pairing**: kiosk shows 8-char code (no 0/O/1/I), admin enters in UI, server delivers `kiosk_key+cluster_key+bundle_url` via one-shot poll.
14. **server never touches RTSP**. server = coordinator. kiosk = puller + decoder + actuator.
15. **single binary, role at runtime**. systemd: `betterframe-server`, `-kiosk`, `-nodered`.
16. **proxy = Angie** (nginx fork). drop-in nginx config.
17. **deploy**: deb pkg + docker-compose first class.
18. **secrets**: systemd-creds prod, dev fallback `data_dir/secret.key` (0600+warn).
19. **no DB on kiosk** — JSON files for cached bundle+state. server = sqlite always.
20. **gpio**: kiosks only. server's node-red nodes fan out via ws.
21. **validation = anyvali (BetterCorp)** — single source of truth for cross-language wire schemas. Schemas authored TS-side, exported to `/schemas/*.av.json`, imported by Rust kiosk + Node-RED TS nodes + browser via vendored `@anyvali/js`. Forms also use anyvali (one schema → server validation + browser HTML5 hints via `initForm` from `@anyvali/js/forms`).
22. **server = TS, not Python**. Pivoted from FastAPI/sqlmodel to BSB v9 + h3. Reasons:
    - Node-RED is already on the box (TS native there)
    - admin UI ships JS to browser anyway
    - same anyvali schemas serve both ends
    - single tsconfig spans server+browser+node-red types
    - BSB gives plugin architecture, observability, multi-instance scaling
    - **prefer raw `@anyvali/js` over `bsb.*` wrappers**, per user (wrappers being cleaned up)
23. **server framework = BSB v9** (`@bsb/base@9.1.11`). `createConfigSchema()` + `createEventSchemas()` patterns. PLUGIN_DEVELOPMENT.md is in v9 branch on github. The published llms.txt service example still shows `import { z } from "zod"` — **STALE; v9 has no zod.** The actual `@bsb/base@9.1.11` example plugins (`node_modules/@bsb/base/lib/plugins/service-default0`) use raw `av.*` from `@anyvali/js`. Match that pattern.
24. **server templating = jsx-htmx** (BetterCorp, by user). `tsconfig.compilerOptions.jsxImportSource = "jsx-htmx"`. JSX returns string (server-side rendered), type-safe htmx attrs (`hx-get`, `hx-on:*`), `css(...)` and `js(...)` helpers for inline. License AGPL-3.0-only OR Commercial — same as BSB.
25. **HTTP framework = h3 v2** (`h3@^2.0.1-rc.22`). Web-standard `Request`/`Response`/`URL`. v1 is legacy. **One h3 instance per http-facing service** (admin, api). Proxy fronts all. Multiple ports is intentional — separate scaling, separate auth posture, separate code surface.
26. **sqlite = `node:sqlite`** built into Node ≥22.5. Sync API (`DatabaseSync`). No native compile, no platform-specific binary. Drops a dep vs `better-sqlite3`. Single-writer: only `service-store` opens the DB; everyone else asks via returnable events.
27. **runtime = pure Node.js** (not Bun/Deno). BSB targets Node ≥23. Pi5 has Node 23 readily available.
28. **service decomposition** (10 services):
    - foundations: `service-store`, `service-secrets`, `service-auth`
    - HTTP: `service-admin-http`, `service-api-http`
    - live: `service-coordinator-ws`, `service-pairing`, `service-bundle`
    - bridges: `service-nodered-bridge`, `service-cec-relay`
    rationale: scale `coordinator-ws` independently per kiosk count, keep admin minimal, isolate stateful pieces, independent test surfaces.

## models (sqlite — translated from old-python)
- users (argon2id pw, totp_secret_encrypted, recovery_codes_hashed JSON, role: admin/operator, must_change_password, locked_until, failed_login_count)
- sessions (id=hex32, csrf_token, totp_pending, sliding 12h + abs 30d expiry)
- api_keys (key_hash, key_prefix indexed, scopes JSON: read/control/admin, expires_at)
- setup_state (singleton id=1, is_complete, cluster_key_provisioned, nodered_flows_deployed)
- displays (index unique, w/h px, default_layout_id, idle_timeout_s, sleep_timeout_s, cec_*, desired_power_state)
- cameras (type: rtsp/onvif, rtsp_url OR onvif host+port+user+pw_encrypted, capabilities, stream_policy)
- camera_streams (role: main/sub/other, profile_token, rtsp_uri, w/h/fps/encoding/bitrate, is_discovered)
- layout_templates (regions JSON, grid_cols/rows, is_builtin)
- layouts (template_id, display_id, priority, cooling_timeout_s, preload_camera_ids JSON, is_default, resets_idle_timer)
- layout_cells (region_name, content_type, camera_id+stream_selector | web_url | html_content, options JSON)
- kiosks (key_hash+prefix, capabilities JSON, hardware_model, paired_at, last_seen_at, last_bundle_version, display_id)
- labels (name `[a-z0-9][a-z0-9_-]*`, color)
- kiosk_labels (composite PK: kiosk_id+label_id+role; role IN consume/operate)
- camera_labels (cam_id+label_id) · layout_labels (layout_id+label_id)
- pairing_codes (PK=code, kiosk_proposed_name, capabilities, expires_at, consumed_at, extras JSON)
- event_log (kiosk_id+camera_id, source_type, topic, property_op, payload JSON, forwarded_to_nodered)

DROPPED—do NOT recreate: `event_rules` (node-red), `shortlinks` (node-red).

## file layout (current)
```
betterframe/
  package.json                 # workspaces: server, nodered
  tsconfig.base.json
  sec-config.yaml              # BSB runtime config (all services declared)
  CLAUDE.md, ARCHITECTURE.md
  
  server/                      # BSB v9 server
    package.json
    tsconfig.json              # extends ../tsconfig.base.json; jsxImportSource=jsx-htmx
    src/
      plugins/
        service-smoke/         # ✅ canonical v9 pattern, compiles clean
        service-store/         # TODO
        service-secrets/       # TODO
        service-auth/          # TODO
        service-admin-http/    # TODO
        service-api-http/      # TODO
        service-coordinator-ws/ # TODO
        service-pairing/       # TODO
        service-bundle/        # TODO
        service-nodered-bridge/ # TODO
        service-cec-relay/     # TODO
      shared/                  # cross-plugin types/utils
      schemas/                 # anyvali schema authoring
        forms/                 # admin form schemas
        wire/                  # cross-language schemas (kiosk + nodered consume these)
        events/                # BSB event input/output schemas
      web-templates/           # jsx-htmx components (.tsx)
      web-static/              # served at /static/
        anyvali/               # vendored @anyvali/js
        htmx.min.js            # vendored
        app.css
  
  schemas/                     # exported .av.json — committed, source of truth
  
  kiosk/                       # rust app (placeholder, future)
  
  nodered/                     # custom nodes (placeholder, future)
  
  scripts/
    vendor-anyvali-js.sh       # ✅ working
    vendor-htmx.sh             # TODO
  
  deploy/                      # angie + systemd + docker-compose (TODO)
  
  old-python/                  # archived FastAPI prototype (reference only)
    backend/                   # full Python implementation
    README.md                  # what was working, what wasn't
```

## conventions
- **TS strict mode** (no implicit any, noUncheckedIndexedAccess on)
- **ESM only**: `"type": "module"`, `module: "NodeNext"`, **import paths use `.js`** even when source is `.ts`
- **Plugin folder = `service-<name>` exactly**; index.ts exports `Config`, `EventSchemas`, `Plugin`
- **Plugin pattern**: `extends BSBService<InstanceType<typeof Config>, typeof EventSchemas>`, `static Config`, `static EventSchemas`, four optional `*Plugins` fields, constructor calls `super(cfg)`
- **Schemas always anyvali raw** (`av.object`, `av.string`, etc.). Skip `bsb.*` wrappers — being cleaned up.
- **Object schemas usually `unknownKeys: "strip"`** for forms (browser sends extras), `"reject"` for wire (drift should fail loud)
- Build: `npm run build` → `bsb-plugin-cli build` writes `lib/` + generates `bsb-plugin.json`
- Dev: `npm run dev` → `bsb-plugin-cli dev` runs `.ts` directly with hot reload
- Logging: `obs.log.info("text {tag}", { tag: value })` — structured

## current build status
- ✅ workspace skeleton, deps, tsconfig hierarchy
- ✅ `@anyvali/js` + `htmx.min.js` vendored
- ✅ all wire + form schemas authored + export script
- ✅ `service-store` — full Repository with CRUD for all entities + display-chain bundle queries
- ✅ shared/secrets — AES-256-GCM + HKDF + cluster key (was plugin, now shared module)
- ✅ shared/auth — argon2id + TOTP + sessions + API keys + kiosk-key (was plugin, now shared module)
- ✅ shared/pairing — 8-char code state machine
- ✅ shared/bundle — display-chain bundle generation (kiosk→display→layouts→cells→cameras)
- ✅ `service-admin-http` — h3 on :18080, full admin UI (setup, login, TOTP, cameras CRUD, kiosks CRUD, labels CRUD, templates CRUD, layouts CRUD with cell management, display editing)
- ✅ `service-api-http` — h3 on :18081, kiosk REST API (pairing, bundle, heartbeat, events)
- ✅ `service-coordinator-ws` — HTTP on :18082 (WS upgrade stub, needs crossws)
- ✅ `tsc --noEmit` clean, `npm run build` passes (4 plugins, 0 errors)
- ✅ end-to-end tested on Raspberry Pi 5 (setup → camera → layout → pair → bundle → display)
- ✅ Rust kiosk app — GTK4 + GStreamer, pairing flow, bundle-driven layout rendering
- ✅ Shell kiosk prototype — auto-detect codec (H264/H265/fallback)
- ❌ coordinator-ws: full WebSocket upgrade (needs crossws or ws package)
- ❌ Node-RED custom nodes + bridge
- ❌ CEC relay
- ❌ Angie proxy config + systemd units + Docker
- ❌ Visual template grid editor (currently preset-based + form)
- ❌ Display auto-discovery from kiosk capabilities

## architecture note: plugins vs shared modules
BSB plugins = actual services (own port, lifecycle, resource ownership).
Everything else is a shared module (plain TS, no BSB lifecycle).

**4 BSB plugins:**
- `service-store` — DB lifecycle, migrations, repository. Registers repo in shared/plugin-registry.ts
- `service-admin-http` — h3 :18080, admin UI. Inits secrets + auth as shared modules in init()
- `service-api-http` — h3 :18081, kiosk REST API. Same shared module pattern
- `service-coordinator-ws` — :18082, live kiosk channel

**Shared modules (server/src/shared/):**
- `secrets.ts` — initSecrets(config, log) → SecretsApi
- `auth.ts` — createAuth(repo, secrets, config) → AuthApi
- `pairing.ts` — initiatePairing, claimPairing, confirmPairing
- `bundle.ts` — generateBundle (display-chain routing)
- `plugin-registry.ts` — store repo singleton for cross-plugin access
- `types.ts` — all domain interfaces
- Stubs: `nodered-bridge.ts`, `cec-relay.ts`

**Why not plugins?** Secrets/auth/pairing/bundle have no ports, no lifecycle. Making them plugins created unnecessary inter-plugin wiring complexity. Shared modules = direct imports, no event bus overhead.

## active TODO
1. **Visual template grid editor** — dynamic grid: starts 1x1, expands as content added, resize blocks
2. **RTSP camera field split** — ✅ done: separate host/port/path/user/pass fields
3. **Display auto-discovery** — kiosk reports connected HDMI displays during pairing/heartbeat
4. **coordinator-ws WebSocket** — install crossws, implement kiosk connections + layout-switch commands
5. **Rust kiosk polish** — multi-camera compositor, H264/H265 auto-detect, web cells via WebKit
6. **Node-RED bridge** — outbound HTTP forwarder + inbound callbacks
7. **Display power relay** — kiosk handles CEC first, then monitor DPMS fallback (`wlr-randr`, then `xset`). Server/admin should keep using generic wake/standby commands, not CEC-only naming.
8. **Angie config** + systemd units + Dockerfile — ✅ baseline native + Docker deployment files exist; Angie now uses auth_request for admin/kiosk-gated Node-RED routes, and Docker uses container upstreams.
9. **Auth-check endpoints** — ✅ admin session/API-key, kiosk key, and API-key checks added for proxy `auth_request`

## conventions (additions discovered while building)
- **BSB build needs tsx**: `cross-env NODE_OPTIONS="--import tsx" bsb-plugin-cli build` in package.json scripts. Required because BSB's schema extractor doesn't resolve .js→.ts imports in multi-file plugins
- **h3 v2 html() is tagged template only** — can't pass string. Use `htmlPage()` helper that returns `new Response(String(markup), { headers: { "content-type": "text/html" } })`
- **h3 v2 setCookie doesn't work with raw Response returns** — set Set-Cookie header on Response directly via `redirectWithCookie()` helper
- **BSB config doesn't apply schema defaults** for keys missing from sec-config.yaml. Always declare config values explicitly
- **Cookie signing uses HKDF-derived key** (deterministic). NOT encryptString (random IV = non-deterministic = broken)
- **RTSP URLs with special chars** in password: URL-encode user/pass components. Camera form splits into host/port/path/user/pass fields, builds URL server-side
- **ONVIF discovery import**: ONVIF profiles are streams, not cameras. Group profiles by VideoSourceConfiguration/SourceToken (fallback to channel-ish URI/name), assign largest stream `main`, next `sub`, rest `other`, and import one camera with multiple `camera_streams`. If RTSP URIs omit userinfo, inject the ONVIF username/password before storing so kiosk playback avoids RTSP 401.
- **Display power**: TVs may support CEC, monitors usually won't. Kiosk power commands should try `cec-ctl`, then standard output sleep/wake (`wlr-randr`, then `xset dpms`) so monitor installs still work.
- **GStreamer on Pi5**: hw H265 decoder rejects non-standard resolutions (960x1080). Use avdec_h265 (sw) as fallback
- **Log message strings MUST be string literals** (BSB SmartLogMeta extracts placeholders from literal type)
- **Datetimes are ISO-8601 strings** stored as TEXT
- **node:sqlite** API: `DatabaseSync`, `.exec()`, `.prepare().run/all/get()`. Synchronous

## file layout (current)
```
betterframe/
  package.json                 # workspaces: server, nodered
  tsconfig.base.json
  sec-config.yaml              # 4 services: store, admin-http, api-http, coordinator-ws
  CLAUDE.md
  
  server/
    package.json               # tsx in devDeps for BSB build
    tsconfig.json              # jsxImportSource=jsx-htmx
    src/
      plugins/
        service-store/         ✅ DB lifecycle + full repository
        service-admin-http/    ✅ h3 + jsx-htmx admin UI
          index.ts, middleware.ts, html-response.ts
          routes-setup.ts, routes-auth.ts, routes-admin.ts, routes-account.ts, routes-static.ts
        service-api-http/      ✅ kiosk REST API (pairing, bundle, heartbeat)
        service-coordinator-ws/ ⚠️ stub (HTTP health only, WS upgrade TODO)
      shared/
        types.ts               ✅ all domain interfaces
        secrets.ts             ✅ AES-256-GCM + HKDF + cluster key
        auth.ts                ✅ argon2id + TOTP + sessions + API keys
        pairing.ts             ✅ 8-char code state machine
        bundle.ts              ✅ display-chain bundle generation
        plugin-registry.ts     ✅ store repo singleton
        nodered-bridge.ts      stub
        cec-relay.ts           stub
      schemas/                 ✅ anyvali schemas (forms, wire, events)
      web-templates/           ✅ jsx-htmx components (layout, auth pages, admin pages)
      web-static/              ✅ vendored htmx.min.js + @anyvali/js
  
  kiosk/
    Cargo.toml                 ✅ Rust GTK4 + GStreamer
    src/
      main.rs, ui.rs, bundle.rs, server.rs, pipeline.rs
    prototype.sh               ✅ shell prototype for quick testing
  
  schemas/                     exported .av.json
  nodered/                     custom nodes (future)
  scripts/                     vendor scripts
  deploy/                      angie + systemd + docker (TODO)
```

## things the docs got wrong (so future-Claude doesn't re-find them)
- BSB **public docs** (`bsbcode.dev/llms/nodejs-plugin-service.txt`) show `import { z } from "zod"` — STALE. v9 ships zero zod, uses anyvali everywhere.
- Same docs use `BSBService<typeof Config, ...>` — should be `InstanceType<typeof Config>`. The actual canonical pattern is in `node_modules/@bsb/base/lib/plugins/service-default0/`.
- `@anyvali/js` Python SDK uses `object_()`/`int_()`/`bool_()` (underscores avoid keyword conflicts), but the **JS SDK uses `object()`/`int()`/`bool()`** without underscores. Only `enum_()` and `null_()` keep the underscore in JS.
- BSB log methods (`obs.log.info` etc.) require **literal-typed** message strings. String concatenation (`"a " + "b"`) widens to `string` and breaks the `SmartLogMeta<T>` placeholder extraction.
