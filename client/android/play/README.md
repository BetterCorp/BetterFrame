# BetterFrame Play store kit

Draft, English-first listing for `cloud.betterportal.frame`. See [publishing setup](../../../docs/android-play-publishing.md).

## Included

- `listings/en-US`: title, short/full descriptions and release-note template.
- `assets/en-US`: opaque 512×512 icon, 1024×500 feature graphic and 1280×720 TV banner using the existing `client/assets/betterframe-logo-dark.svg` as the source. The square store and Android launcher icons use its display mark; banners retain the complete wordmark.
- `assets/source`: editable SVG sources. Rebuild with `python3 client/android/scripts/render-play-assets.py --help` and an installed `rsvg-convert`.
- Default Android resources now contain the main settings, enrollment and power-menu strings, ready for translation. Remaining camera/renderer diagnostics and error messages still need a translation pass.

Store language and app language are separate. For each approved language, add `listings/<Play-locale>`, localized assets/screenshots, and a matching Android `res/values-<qualifier>/strings.xml`; add the locale to config.json. Have a fluent reviewer check translations and actual device rendering. The app currently uses English fallback; no additional language is claimed as complete.

## Required from the owner

- Confirm launch languages (default en-US), internal vs closed testing, and countries.
- Public support email, website and a publicly accessible privacy-policy URL; enter the approved details in config.json and Console.
- Approve listing copy and real screenshots; set config flags only after review.
- Legal publisher identity, app category, free/paid distribution, content rating, target audience, ads declaration and Data safety answers.
- Working reviewer account/demo tenant, stable server and repeatable enrollment instructions that do not require staff intervention. Supply credentials privately through Console, never this repository.
- Confirm TV distribution and complete its form-factor review. Supply screenshots for supported phone/tablet/TV listings; capture representative 7-inch and 10-inch tablet layouts where Console requests them.

## Screenshot capture

Use a demo tenant with staged camera footage and non-sensitive content. Capture the real app: multi-camera grid, mixed signage/web layout, and enrollment/settings where helpful. Do not include live customer cameras, identifiers, pairing codes, tokens or personal information. Screenshots are intentionally pending; the supplied feature graphic is promotional artwork, not an app screenshot.

```sh
python3 client/android/scripts/capture-play-screenshot.py --serial DEVICE_SERIAL --family phone --name camera-grid
# Repeat with --family tablet or tv and distinct names/layouts.
```

The script requires adb and an already running, enrolled demo device. It captures without altering device settings. Review images before committing. At least two phone, two tablet and one landscape 16:9 TV PNG are checked by `--ready`; Console may request additional form-factor assets. Use 16:9/9:16 capture surfaces so screenshot aspect ratio meets the checker.

## Privacy and Data safety intake — not a published policy

Document the actual production service before answering Console forms:

- The viewer enrolls to a BetterFrame server and handles device identity/enrollment credentials, configuration, assigned layouts and connection status. Determine what the operator stores, retention and deletion procedure.
- Camera URLs/credentials and web content can be delivered to the display. Identify whether video is direct to a camera or proxied/recorded by the deployment; do not claim video is never collected without checking the server configuration.
- WebView content can contact third-party websites. Inventory their cookies, tracking and data collection, alongside any application/server logging or analytics.
- Explain local credential storage, TLS use, and supported local cleartext camera endpoints. Do not make an unconditional “all data encrypted in transit” claim if cleartext is supported.
- Identify the responsible organization, contact, purposes, recipients/processors, retention, deletion/contact process, and any account-deletion obligations. Verify which permissions/features actually apply to the shipped app.
- Optional managed-device/kiosk provisioning needs clear reviewer instructions and appropriate disclosure; normal installation must be evaluated separately.

Have the service owner approve a policy matching actual behavior and complete Console's Data safety, app access and content declarations. This checklist is an engineering input, not finished legal text or a pre-filled claim of no data collection.

[Google listing asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en)
