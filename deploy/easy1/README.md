# easy1 release deployment

Published BetterFrame releases deploy the server, Node-RED nodes/manager, and
proxy configuration in the existing `betterframe` project on easy1. Stable and
versioned prereleases are accepted: `v1.2.3`, `v1.2.3-alpha.1`, `v1.2.3-beta.1`,
and `v1.2.3-dev.abcdef0`. Bare branches or channel names are rejected. Alpha
releases use the existing client `dev` update channel.

The release workflow calls `easy1-deploy.yml` after server validation and
publication of the release record. This explicit call is necessary because
GitHub does not trigger a second workflow for releases created with
`GITHUB_TOKEN`. Manually published releases also trigger deployment. Deployment
does not wait for the separate APK, firmware, or OS image builds.

All deployment entrypoints share one concurrency group and active deployments
are never cancelled by a newer release. Duplicate invocations skip rebuilding
healthy services already running the requested commit/version. An older commit
cannot replace a deployed descendant. GitHub concurrency can replace a pending
run with a newer pending run; it does not guarantee deployment of every
intermediate release.

## Configuration

- Repository secret `EASY1_API_TOKEN`: dedicated non-administrator easy1 user
  with access only to the `betterframe` project.
- Repository variable `EASY1_API_URL`: `https://easy1.eu2.betterweb.co.za/api`.
- GitHub's automatically supplied token reads release/tag metadata.

No server environment values are copied into the workflow. Existing service
environment, domains, persistent volumes, and PostgreSQL remain configured in
easy1. API responses and build errors can contain secrets, so the script prints
only its own progress and error messages; inspect build details in easy1.

## Deployment checks

The script verifies a published release and resolves its tag to the requested
full commit before changing easy1. It downloads that exact source archive and
embeds its SHA-256 checksum in both Dockerfiles. After deployment it requires
healthy containers carrying the expected revision/version labels and verifies
the regional `/healthz`, `/readyz`, and `/version` endpoints.

Proxy configuration comes from the released commit with only Compose upstream
names adapted to easy1's service names. The canonical
`frame.betterportal.net` redirect to `frame-eu.betterportal.net` is preserved;
clients discover and remember their regional server.

The Dockerfiles preserve easy1's existing migrated BetterCorp runtime and replace
the BetterFrame application files. They build on the service's current local
`easypanel/betterframe/<service>:latest` image. The **application source and
reported version** are pinned to the release; the inherited runtime is local to
this installation. These templates are therefore for this existing deployment,
not a fresh-server bootstrap. Repeated updates retain underlying image layers;
runtime upgrades or rebuilding the base need a separate migration.

## Rehearsal and retry

From a checkout with tags and authenticated `gh` access:

```sh
python3 deploy/easy1/deploy.py --tag v1.2.3-beta.1 --commit FULL_COMMIT_SHA --dry-run
```

The dry run verifies the published release and renders the deployment plan
without an easy1 token or mutations. Once the workflow is on `master`, use the
Actions **deploy easy1** manual run with an existing published tag to retry a
failed deployment. Deployment stops on failure and reports the failed stage;
there is no automatic database rollback. A partial deployment can be retried
with the same tag.
