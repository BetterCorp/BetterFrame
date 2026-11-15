# Web action groups

Linux players can run the existing browser step types on a web, HTML, dashboard or AbleSign layout block: navigate, fill, click, wait, wait for an element, and JavaScript. Configure **Web actions** in the layout block editor. Entity authentication remains on the entity and runs only on its matching login URL prefix.

**On-load steps** run when the block is shown and ready, after entity login. A cached block runs its on-load steps again when shown. Named groups run only when explicitly called. Groups are generic sequences: users define their own actions and any press/release behaviour.

## Calling a group

Send an authenticated request through the same server address as the admin API:

```http
POST /api/displays/DISPLAY_ID/web-actions/GROUP_NAME
Authorization: Bearer ADMIN_API_KEY
Content-Type: application/json

{"layout_id":"LAYOUT_ID","cell_id":"BLOCK_ID"}
```

An authenticated operator session may also call groups, using the normal CSRF token. Group names start with a letter, contain letters, digits, dots, dashes or underscores, and have at most 64 characters. Each block supports up to 32 groups, with up to 50 steps in each group or on-load sequence.

A `202` response contains `accepted: true` and `request_id`. It confirms delivery to the player; completion is asynchronous. Player and server diagnostic logs record completion or failure with that request ID. It is not an execution receipt. Requests are never queued for an offline player (`503`). Unsupported players return `409`.

At invocation, the player requires the specified layout and block to be active and ready, with the same configuration revision as the server. An accepted sequence continues as authored if its cached block is later hidden; hiding does not add, cancel or rewrite actions. Disposal of the browser stops its remaining steps. Missing groups, stale configuration, a busy block or an inactive block do not execute a sequence; the player reports the failure. A failed step stops subsequent steps. There are no automatic retries or compensating actions for named groups.

Fill values are encrypted per player in bundles, using the same mechanism as entity authentication. Page storage and login state remain disposable; actions should account for pages needing to authenticate or rebuild their cache. Windows and Android do not advertise support for this feature yet.
