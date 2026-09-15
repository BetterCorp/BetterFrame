# Android Google Play publishing

Publishing is prepared but **disabled** until `BF_PLAY_PUBLISH_ENABLED=true` is set as a repository variable. Do not enable it until the first Play release and store setup below are complete.

## GitHub triggers

| Existing release trigger | Play destination |
| --- | --- |
| Push to `master` producing a dev prerelease | `internal`, or the named test track in `BF_PLAY_DEV_TRACK` |
| Stable signed `vX.Y.Z` tag producing a stable release | `production` |
| Beta prerelease | The same configured test track |
| Pull request | Build and validation only |

The existing `release.yml` builds the APK and AAB once. The publishing job consumes the verified AAB from that same run, validates an edit, then commits only its destination track. Stable versions cannot be routed from a branch run. Test versions cannot target production. Production submission requests a completed release; Google review and Play Console managed-publishing settings still determine when users receive it. For availability automatically after approval, configure managed publishing accordingly.

All channels use the same package, `cloud.betterportal.frame`, and the existing monotonically increasing release workflow run number as versionCode, plus `BF_ANDROID_VERSION_CODE_OFFSET` if configured. Check the highest code already uploaded before enabling; set a sufficient offset if needed. Never decrease the offset or reuse a code for different bytes. Testers can receive a newer test build instead of an older production build. These are not separately installable dev/prod apps.

Retry a failed publishing job using **Re-run failed jobs**, preserving the verified artifact. Rebuilding all jobs can produce different bundle bytes with the same code, which the publisher rejects. If necessary create a new release run/version. Artifacts expire after 30 days. Publishing serializes across tracks and skips an older build when a newer code is already on its target track. Do not edit the same app in Play Console while an automated edit is underway.

## One-time Play Console setup

1. Create/verify the Play Console developer account and app with package `cloud.betterportal.frame`. Android Developer Console registration for outside-Play distribution does **not** create a Play Console app. Confirm organization/legal identity, countries, free/paid choice, category and supported form factors.
2. Configure Play App Signing using the **existing app signing key**, importing it through Google's PEPK process. Do not let Google generate an unrelated app signing key if existing sideload installations must update through Play. Compare the resulting app signing SHA-256 with `BF_ANDROID_CERT_SHA256` (currently `14E5F10E07D5745F62370599473B3F4E5678F5146A4216EE5F2DF5A85BDB07E4`). The current build signs APK and AAB with the existing key. A separate upload key is desirable later, but requires separate AAB signing configuration and certificate verification first; changing the existing APK key breaks upgrade continuity.
3. Upload the first verified AAB manually and complete the initial release/setup in Console. Create the internal test track and tester email list/Google Group; send testers the opt-in link. Set up a named closed track instead if required. Newly created personal developer accounts can require 12 opted-in closed testers for 14 continuous days before production access; internal testing does not satisfy that requirement.
4. Complete the listing and policy checklist in `client/android/play/README.md`. Provide Google reviewers a working demo enrollment flow and server, with instructions and credentials supplied privately in Console. Reviewers must be able to access app features without contacting an administrator.
5. Enable Android Publisher API in a Google Cloud project. Create a dedicated service account and invite its email through Play Console **Users and permissions**, scoped only to BetterFrame. Grant app visibility plus test-track release permission and production release permission. Do not grant unrelated financial/admin permissions.
6. Configure Google Workload Identity Federation for GitHub OIDC and permit that identity to impersonate the service account (`roles/iam.workloadIdentityUser`). No long-lived JSON key is needed. Map `google.subject=assertion.sub` and the repository/owner/ref claims. Restrict the provider condition to numeric repository ID `1234229160`, owner ID `22332366`, and refs `refs/heads/master` or `refs/tags/v*`. Also restrict the workflow claim to BetterCorp/BetterFrame's `android-publish-play.yml`. Use Google's deployment-pipeline guide to create the pool/provider and principal binding; do not use an unrestricted pool-wide binding.
7. Create GitHub environments `google-play-testing` and `google-play-production`. Restrict testing to master and version tags; restrict production to version tags. Required reviewers are optional: adding them makes production require approval instead of being fully automatic. Protect master and release tags from unauthorized writes.
8. Configure these GitHub Actions variables:

   | Variable | Value |
   | --- | --- |
   | `BF_GOOGLE_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` |
   | `BF_PLAY_SERVICE_ACCOUNT` | Dedicated service account email |
   | `BF_PLAY_DEV_TRACK` | `internal` (default), or exact closed-test track ID |
   | `BF_PLAY_PUBLISH_ENABLED` | `true` **last**, after setup and validation |

   Provider and service account can be environment variables, allowing different accounts with test-only and production permissions. The enable flag must be a repository variable because the caller checks it before entering an environment. Existing four `BF_ANDROID_*` signing secrets and certificate variable remain required.
9. Merge this preparation, download the first verified AAB from its GitHub release for initial Console setup, then enable the flag. Confirm the next master release reaches testers. Create the next normal stable signed tag to submit production. A stable release created before this workflow exists cannot retrospectively trigger it simply by enabling the flag.

### Federation condition

Use this provider attribute condition (and map the referenced attributes):

```text
assertion.repository_id == '1234229160' &&
assertion.repository_owner_id == '22332366' &&
(assertion.ref == 'refs/heads/master' || assertion.ref.startsWith('refs/tags/v')) &&
assertion.job_workflow_ref.startsWith('BetterCorp/BetterFrame/.github/workflows/android-publish-play.yml@')
```

Bind service-account impersonation to the repository attribute principal set within this pool. Enable the IAM, Security Token Service, Service Account Credentials and Android Publisher APIs. Because the job uses environments, its OIDC subject contains the environment; use repository/ref claims as above instead of assuming a branch-shaped subject.

## Validation and limits

Run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s client/android/scripts -p 'test_*.py' -v
python3 client/android/scripts/check-play-metadata.py
python3 client/android/scripts/check-play-metadata.py --ready
python3 client/android/scripts/publish-play.py --plan --version 1.0.3-dev.gabc --channel dev
python3 client/android/scripts/publish-play.py --plan --version 1.0.3 --channel stable
```

`--ready` deliberately fails until actual screenshots and owner-approved contact/policy inputs exist. It is a local completeness check, not Google policy approval. CI builds target API 36, checks signatures/package/version, and verifies 16 KB native alignment before releasing. Physical phone, tablet and TV testing, including enrollment, remote control and camera playback, remains necessary. No Play credentials, Console app, tester memberships or production release are created by this PR.

The workflow updates the AAB and localized release notes only. Upload listing descriptions and image assets to Console during initial setup; subsequent text/image changes also require Console review. Update the checked-in release notes before each release; the initial file is a draft template.

## Official references

- [Target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [AGP/API compatibility](https://developer.android.com/build/releases/about-agp)
- [16 KB page sizes](https://developer.android.com/guide/practices/page-sizes)
- [Play App Signing and existing keys](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en)
- [Personal-account production testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en-GB)
- [Android Publisher service account access](https://developers.google.com/android-publisher/getting_started)
- [Workload Identity Federation for deployment pipelines](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Play tracks](https://developers.google.com/android-publisher/tracks)
