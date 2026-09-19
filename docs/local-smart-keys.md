# Local LAN smart keys

The existing Local LAN endpoints and their UI examples remain available. Smart-key links are additional GET routes on the Linux kiosk's LAN listener:

| Action | URL path and query |
| --- | --- |
| Assigned layout | `/lsh/<layout-key>?key=<local-key>` |
| PTZ stop | `/lsh/<camera-key>/s?key=<local-key>` |
| PTZ move | `/lsh/<camera-key>/m?key=<local-key>&dir=left` |
| PTZ preset | `/lsh/<camera-key>/p/<preset-token>?key=<local-key>` |

Layout and camera keys are six random lowercase hexadecimal characters. The server migration backfills existing records and assigns keys to new records, including cloned layouts. Keys survive edits, restarts, and reassignment. The tenant's registry retries collisions and retains deleted keys so they cannot be allocated to another resource. These identifiers are only resolved on `/lsh`; other endpoints still use full IDs.

The full kiosk local key remains required. Rotating it invalidates the old URLs without changing layout/camera identifiers. Layout keys resolve only against the kiosk's cached assigned layouts, and camera keys only against enabled cameras in its bundle. Unknown or unassigned keys return 404, invalid authentication returns 401, and a missing bundle returns 503.

The kiosk admin page lists assigned-layout links and PTZ links for its scoped ONVIF cameras alongside the normal endpoint examples. Links include character counts and flag values over 127 characters. For `192.168.74.132:18090` with a 64-character local key, a layout link is 107 characters. PTZ preset examples use token `1`; substitute the actual camera preset token, URL-encoded as a path segment. Preset tokens and optional parameters can make a link longer than 127 characters; the short resource identifier does not truncate them.

PTZ move accepts the existing `dir`, `speed`, `timeoutMs`, and `profileToken` parameters. The default move speed is 0.5 and timeout is 1000 ms. Stop and preset accept optional `profileToken`; when omitted, the existing ONVIF executor chooses a profile. Directions remain `left`, `right`, `up`, `down`, `upleft`, `upright`, `downleft`, `downright`, `zoomin`, and `zoomout`.

Deploy the server migration and update Linux kiosk firmware, then allow the kiosk to refresh its bundle before using the added links. Older bundles remain readable but have no smart keys.
