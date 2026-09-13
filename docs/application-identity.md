# Application identity and domains

BetterFrame's canonical base application ID is `cloud.betterportal.frame`.
The Android/Android TV application ID, Kotlin namespace and native JNI bindings
use this identity. The Linux GTK application uses the same ID.

Application IDs identify installed applications; they are not server addresses.
Moving a service between hostnames does not require changing an application ID.
Keep this ID stable when configuring production signing and subsequent updates.

## BetterPortal domain conventions

| Domain | Purpose |
| --- | --- |
| `betterportal.cloud` | Main BetterPortal frontend |
| `betterportal.net` | Services and hosting |
| `betterportal.app` | Applications without custom hostnames yet |
| `betterportal.org` | Open-source variant |

BetterCorp organization names and GitHub repository URLs are separate from these
domain conventions. Storage paths, protocol identifiers and Windows installer
upgrade GUIDs retain their existing values.

## Pre-release Android identity correction

The initial experimental Android builds used `net.bettercorp.betterframe.viewer`.
That namespace was incorrect: `bettercorp.net` is not owned by this project.
Android treats `cloud.betterportal.frame` as a different application, so those
earlier installations cannot receive it as an in-place update. Install the
corrected app and pair it again; its private enrollment data and Keystore are
separate. Future releases must retain the corrected application ID and a
compatible signing certificate for in-place updates.
