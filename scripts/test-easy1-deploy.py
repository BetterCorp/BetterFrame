#!/usr/bin/env python3
"""Offline regression tests for the easy1 release deployment boundary."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("easy1_deploy", Path(__file__).parents[1] / "deploy/easy1/deploy.py")
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)
SHA = "a" * 40
OTHER = "b" * 40
TAG = "v1.2.3-dev.abc1234"
VERSION = TAG[1:]
PROXY = """upstream betterframe_admin { server server:18080; }
upstream betterframe_api { server server:18081; }
upstream betterframe_ws { server server:18082; }
upstream betterframe_nodered { server nodered:1880; }
server { server_name frame.betterportal.net; return 307 https://frame-eu.betterportal.net$request_uri; }
"""
MANAGER = 'const EASY1_READINESS_CONTRACT = 1;\nif (url.pathname === "/readyz") { /* supported readiness endpoint */ }'


def release_archive(manager=MANAGER):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for path, content in {"deploy/angie/betterframe.docker.conf": PROXY,
                              "deploy/nodered-manager/manager.mjs": manager}.items():
            data = content.encode()
            member = tarfile.TarInfo(f"BetterFrame-{SHA}/{path}")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return stream.getvalue()


def container(commit=SHA, version=VERSION, health="healthy"):
    return {"Id": "old-container", "State": "running", "Health": {"Status": health}, "Labels": {
        "org.opencontainers.image.revision": commit, "org.opencontainers.image.version": version}}


def plan():
    return {"tag": TAG, "commit": SHA, "version": VERSION,
            "dockerfiles": {"server": "server build", "nodered": "nodered build"}, "proxy": PROXY}


class FakeApi:
    def __init__(self, current=None, proxy="old"):
        self.current = current or {}
        self.proxy = proxy
        self.calls = []

    def get(self, method, **values):
        self.calls.append((method, values))
        if method == "getDockerContainers":
            service = values["service"].removeprefix("betterframe_")
            return self.current.get(service, [])
        if method == "inspectAppService":
            return {"name": values["serviceName"], "projectName": "betterframe", "mounts": [
                {"type": "file", "mountPath": DEPLOY.PROXY_PATH, "content": self.proxy}]}
        raise AssertionError("unexpected query")

    def post(self, method, service, **values):
        self.calls.append((method, {"serviceName": service, **values}))


class DeploymentTests(unittest.TestCase):
    def test_server_healthcheck_requires_successful_readiness_body(self):
        template = (Path(__file__).parents[1] / "deploy/easy1/server.Dockerfile").read_text()
        healthcheck = next(line for line in template.splitlines() if line.startswith("HEALTHCHECK "))
        command = shlex.split(healthcheck.split(" CMD ", 1)[1])
        self.assertEqual(command[:2], ["node", "-e"])
        # Execute the production command with real Fetch Response parsing, but
        # substitute the loopback transport so no live server or port is needed.
        harness = """
globalThis.fetch = async (url, options) => {
  if (url !== 'http://127.0.0.1:18080/readyz' || !(options.signal instanceof AbortSignal)) {
    throw new Error('Healthcheck target or timeout missing');
  }
  const fixture = JSON.parse(process.argv[1]);
  if (fixture.reject) throw new Error('Connection refused');
  return new Response(fixture.body, {status: fixture.code});
};
"""
        for label, fixture, expected in [
            ("ready", {"code": 200, "body": '{"status":"ready"}'}, 0),
            ("setup or database not ready", {"code": 200, "body": '{"status":"not_ready"}'}, 1),
            ("failed HTTP response", {"code": 503, "body": '{"status":"ready"}'}, 1),
            ("invalid JSON", {"code": 200, "body": "not-json"}, 1),
            ("missing status", {"code": 200, "body": "{}"}, 1),
            ("null JSON", {"code": 200, "body": "null"}, 1),
            ("transport failure", {"reject": True}, 1),
        ]:
            with self.subTest(label=label):
                result = subprocess.run([command[0], "-e", harness + command[2], json.dumps(fixture)],
                                        capture_output=True, text=True, timeout=10, check=False)
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_release_images_use_fixed_runtime_snapshots_in_every_stage(self):
        for service in ("server", "nodered"):
            with self.subTest(service=service):
                template = (Path(__file__).parents[1] / f"deploy/easy1/{service}.Dockerfile").read_text()
                bases = [line.split()[1] for line in template.splitlines() if line.startswith("FROM ")]
                self.assertEqual(bases, [f"easypanel/betterframe/runtime-{service}-5b29a29:latest"] * 2)
                self.assertNotIn(f"easypanel/betterframe/{service}:latest", bases,
                                 "Release images must not accumulate previous application layers")
                entrypoint = ('ENTRYPOINT ["/usr/local/bin/bf-entrypoint.sh"]' if service == "server"
                              else 'ENTRYPOINT ["node", "/usr/src/betterframe-manager/manager.mjs"]')
                self.assertIn(entrypoint, template)
                self.assertIn("CMD []", template)
                self.assertNotIn('ENTRYPOINT ["/bin/sleep"', template,
                                 "Application images must replace the inert snapshot command")

    def test_nodered_release_installs_lockfile_and_replaces_the_previous_application_tree(self):
        template = (Path(__file__).parents[1] / "deploy/easy1/nodered.Dockerfile").read_text()
        self.assertIn("WORKDIR /tmp/betterframe-source", template)
        self.assertIn("npm ci --omit=dev --workspace=nodered", template)
        self.assertIn("npm ls --omit=dev --workspace=nodered", template)
        self.assertIn("RUN rm -rf /usr/src/betterframe-nodes /usr/src/betterframe-release", template)
        self.assertIn("/tmp/betterframe-source/nodered/ /usr/src/betterframe-release/nodered/", template)
        self.assertIn("/tmp/betterframe-source/node_modules/ /usr/src/betterframe-release/node_modules/", template)
        self.assertIn("ln -s /usr/src/betterframe-release/nodered /usr/src/betterframe-nodes", template)
        self.assertIn("http://127.0.0.1:1880/readyz", template)
        self.assertIn('ENTRYPOINT ["node", "/usr/src/betterframe-manager/manager.mjs"]', template)

    def test_nodered_locked_workspace_dependencies_resolve_after_runtime_relocation(self):
        # Exercise actual npm installation using local tarballs: no registry or
        # credentials. A prior release's removed dependency must not survive.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            workspace = source / "nodered"
            workspace.mkdir(parents=True)
            (source / "package.json").write_text(json.dumps({"name": "release-fixture", "private": True, "workspaces": ["nodered"]}))
            (workspace / "package.json").write_text(json.dumps({"name": "@betterframe/nodered-nodes", "version": "1.0.0", "dependencies": {"released-dependency": "file:../dependency.tgz"}}))
            with tarfile.open(source / "dependency.tgz", "w:gz") as archive:
                for name, content in {"package.json": json.dumps({"name": "released-dependency", "version": "2.0.0", "main": "index.js"}),
                                      "index.js": "module.exports = 'released-2.0.0';"}.items():
                    data = content.encode()
                    member = tarfile.TarInfo("package/" + name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            # Use a private npm cache and remain offline even during lock creation.
            environment = {**os.environ, "npm_config_cache": str(root / "npm-cache"), "npm_config_offline": "true", "npm_config_audit": "false", "npm_config_fund": "false"}
            subprocess.run(["npm", "install", "--package-lock-only", "--ignore-scripts", "--workspace=nodered"], cwd=source, env=environment, check=True, capture_output=True, timeout=60)
            (workspace / "node_modules/removed-dependency").mkdir(parents=True)
            (workspace / "node_modules/removed-dependency/index.js").write_text("module.exports = 'obsolete';")
            subprocess.run(["npm", "ci", "--omit=dev", "--workspace=nodered"], cwd=source, env=environment, check=True, capture_output=True, timeout=60)
            release = root / "runtime/betterframe-release"
            release.mkdir(parents=True)
            shutil.copytree(workspace, release / "nodered", symlinks=True)
            shutil.copytree(source / "node_modules", release / "node_modules", symlinks=True)
            nodes_dir = release.parent / "betterframe-nodes"
            nodes_dir.symlink_to(release / "nodered", target_is_directory=True)
            (release / "nodered/probe.js").write_text("console.log(require('released-dependency')); console.log(require.resolve('@betterframe/nodered-nodes/package.json')); try { require.resolve('removed-dependency'); process.exit(1); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }")
            # The original checkout must not accidentally satisfy a broken link.
            shutil.rmtree(source)
            result = subprocess.run(["node", str(nodes_dir / "probe.js")], check=True, capture_output=True, text=True, timeout=30)
            self.assertIn("released-2.0.0", result.stdout)
            self.assertIn(str(release / "nodered/package.json"), result.stdout)

    def test_invalid_tags_and_short_or_injected_commits_fail_before_github(self):
        with patch.object(DEPLOY, "github") as github:
            for tag in ("latest", "master", "v1", "v1.2.3-rc.1", "v01.2.3", "v1.2.3\nRUN evil"):
                with self.subTest(tag=tag), self.assertRaises(DEPLOY.DeploymentError):
                    DEPLOY.verify_release(tag, SHA)
            for commit in ("abc1234", SHA + ";true", "A" * 40):
                with self.subTest(commit=commit), self.assertRaises(DEPLOY.DeploymentError):
                    DEPLOY.verify_release(TAG, commit)
            github.assert_not_called()

    def test_published_release_must_resolve_to_exact_commit(self):
        release = {"tag_name": TAG, "draft": False, "published_at": "2026-01-01"}
        for target in ({"type": "commit", "sha": OTHER}, {"type": "tree", "sha": SHA}):
            with patch.object(DEPLOY, "github", side_effect=[release, {"object": target}]):
                with self.assertRaisesRegex(DEPLOY.DeploymentError, "does not match"):
                    DEPLOY.verify_release(TAG, SHA)
        with patch.object(DEPLOY, "github", return_value={**release, "draft": True}):
            with self.assertRaisesRegex(DEPLOY.DeploymentError, "published"):
                DEPLOY.verify_release(TAG, SHA)

    def test_annotated_tag_resolves_to_commit(self):
        replies = [{"tag_name": TAG, "draft": False, "published_at": "2026-01-01"},
                   {"object": {"type": "tag", "sha": OTHER}},
                   {"object": {"type": "commit", "sha": SHA}}]
        with patch.object(DEPLOY, "github", side_effect=replies):
            DEPLOY.verify_release(TAG, SHA)

    def test_templates_and_proxy_come_from_checksummed_exact_commit_archive(self):
        archive_bytes = release_archive()
        with patch.object(DEPLOY, "request", return_value=archive_bytes) as request:
            rendered = DEPLOY.source_plan(TAG, SHA)
        request.assert_called_once_with(f"https://codeload.github.com/BetterCorp/BetterFrame/tar.gz/{SHA}",
                                        limit=128 * 1024 * 1024)
        digest = hashlib.sha256(archive_bytes).hexdigest()
        for service, dockerfile in rendered["dockerfiles"].items():
            self.assertIn(f"ADD --checksum=sha256:{digest}", dockerfile)
            self.assertIn(f"/tar.gz/{SHA}", dockerfile)
            self.assertIn(f'org.opencontainers.image.revision="{SHA}"', dockerfile)
            self.assertIn(f'org.opencontainers.image.version="{VERSION}"', dockerfile)
            self.assertIn(f"FROM easypanel/betterframe/runtime-{service}-5b29a29:latest", dockerfile)
            self.assertNotIn("@COMMIT@", dockerfile)
        self.assertIn("betterframe_server:18080", rendered["proxy"])
        self.assertIn("betterframe_nodered:1880", rendered["proxy"])
        self.assertIn("return 307 https://frame-eu.betterportal.net$request_uri;", rendered["proxy"])

    def test_release_without_readiness_contract_is_rejected_before_easy1_access(self):
        for manager in ('if (url.pathname === "/healthz") {}',
                        'if (url.pathname === "/readyz") {}',
                        'const EASY1_READINESS_CONTRACT = 1;'):
            with self.subTest(manager=manager), patch.object(DEPLOY, "request", return_value=release_archive(manager)), \
                    patch.object(DEPLOY, "verify_release"), patch.object(DEPLOY, "Easypanel") as api, \
                    contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(DEPLOY.main(["--tag", TAG, "--commit", SHA]), 1)
                self.assertIn("refusing unsupported release", errors.getvalue())
                api.assert_not_called()

    def test_healthy_old_revision_or_wrong_version_does_not_satisfy_rollout(self):
        self.assertTrue(DEPLOY.healthy_containers([container()], SHA, VERSION))
        for containers in ([], [container(OTHER)], [container(version="old")],
                           [container(health="starting")], [container(), container(OTHER)]):
            self.assertFalse(DEPLOY.healthy_containers(containers, SHA, VERSION))

    def test_server_finishes_before_nodered_and_proxy_is_updated_last(self):
        api = FakeApi()
        order = []
        original_post = api.post

        def post(method, service, **values):
            order.append((method, service))
            original_post(method, service, **values)

        api.post = post
        with patch.object(DEPLOY, "wait_service", side_effect=lambda api, service, *args, **kwargs: order.append(("healthy", service))), \
                patch.object(DEPLOY, "wait_for", side_effect=lambda name, predicate, **kwargs: order.append(("public-ready", name))), \
                contextlib.redirect_stdout(io.StringIO()):
            DEPLOY.deploy(api, plan())
        self.assertEqual(order[:3], [("updateAppSourceDockerfile", "server"), ("deployAppService", "server"), ("healthy", "server")])
        self.assertEqual(order[4:7], [("updateAppSourceDockerfile", "nodered"), ("deployAppService", "nodered"), ("healthy", "nodered")])
        self.assertEqual(order[7:10], [("updateMount", "angie"), ("restartAppService", "angie"), ("healthy", "angie")])
        mount = next(values for method, values in api.calls if method == "updateMount")
        self.assertEqual(mount["values"], {"type": "file", "mountPath": DEPLOY.PROXY_PATH, "content": PROXY})

    def test_server_failure_never_starts_nodered_or_changes_proxy(self):
        api = FakeApi()
        with patch.object(DEPLOY, "wait_service", side_effect=DEPLOY.DeploymentError("failed health")), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.deploy(api, plan())
        writes = [(method, values["serviceName"]) for method, values in api.calls if method.startswith(("update", "deploy"))]
        self.assertEqual(writes, [("updateAppSourceDockerfile", "server"), ("deployAppService", "server")])

    def test_healthy_existing_release_skips_build_but_reconciles_proxy(self):
        api = FakeApi({"server": [container()], "nodered": [container()]})
        with patch.object(DEPLOY, "wait_service"), patch.object(DEPLOY, "wait_for"), contextlib.redirect_stdout(io.StringIO()):
            DEPLOY.deploy(api, plan())
        mutations = [method for method, values in api.calls if method.startswith(("update", "deploy", "restart"))]
        self.assertEqual(mutations, ["updateMount", "restartAppService"])

    def test_stale_queued_release_is_refused_before_any_mutation(self):
        api = FakeApi({"server": [container(OTHER)]})
        with patch.object(DEPLOY.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            with self.assertRaisesRegex(DEPLOY.DeploymentError, "older than"):
                DEPLOY.deploy(api, plan())
        self.assertFalse(any(method.startswith(("update", "deploy", "restart")) for method, _ in api.calls))

    def test_same_commit_dev_to_stable_promotion_is_allowed(self):
        api = FakeApi({"server": [container()], "nodered": [container()]})
        stable = {**plan(), "tag": "v1.2.3", "version": "1.2.3"}
        with patch.object(DEPLOY, "wait_service"), patch.object(DEPLOY, "wait_for"), contextlib.redirect_stdout(io.StringIO()):
            DEPLOY.deploy(api, stable)
        deployed = [values["serviceName"] for method, values in api.calls if method == "deployAppService"]
        self.assertEqual(deployed, ["server", "nodered"])

    def test_same_commit_older_versions_are_refused_before_any_mutation(self):
        cases = (("1.2.3", "1.2.3-dev.abc1234"),
                 ("1.10.0", "1.9.9"),
                 ("2.0.0", "1.99.99"),
                 ("1.2.3-beta.10", "1.2.3-beta.2"),
                 ("1.2.3-beta.2.extra", "1.2.3-beta.2"),
                 ("1.2.3-beta.build", "1.2.3-beta.10"))
        for current, requested in cases:
            # A downgrade on Node-RED must be caught during preflight, before
            # even the server's source configuration is changed.
            api = FakeApi({"nodered": [container(version=current)]})
            release = {**plan(), "tag": "v" + requested, "version": requested}
            with self.subTest(current=current, requested=requested), self.assertRaisesRegex(DEPLOY.DeploymentError, "older than the deployed version"):
                DEPLOY.deploy(api, release)
            self.assertFalse(any(method.startswith(("update", "deploy", "restart")) for method, _ in api.calls))

    def test_same_commit_numeric_prerelease_promotion_and_same_version_are_allowed(self):
        for current, requested in (("1.2.3-beta.2", "1.2.3-beta.10"), ("1.2.3", "1.2.3")):
            with self.subTest(current=current, requested=requested):
                DEPLOY.prevent_stale_deployment([container(version=current)], SHA, requested)

    def test_same_commit_missing_version_cannot_bypass_stale_guard(self):
        with self.assertRaisesRegex(DEPLOY.DeploymentError, "version label is missing or invalid"):
            DEPLOY.prevent_stale_deployment([container(version=None)], SHA, VERSION)

    def test_retry_with_saved_proxy_mount_still_restarts_and_waits_for_replacement(self):
        api = FakeApi({"server": [container()], "nodered": [container()], "angie": [container()]}, proxy=PROXY)
        with patch.object(DEPLOY, "wait_service") as wait, patch.object(DEPLOY, "wait_for"), contextlib.redirect_stdout(io.StringIO()):
            DEPLOY.deploy(api, plan())
        mutations = [method for method, values in api.calls if method.startswith(("update", "deploy", "restart"))]
        self.assertEqual(mutations, ["restartAppService"])
        wait.assert_called_once_with(api, "angie", timeout=120, previous_ids={"old-container"})

    def test_previous_healthy_proxy_container_cannot_satisfy_restart(self):
        api = FakeApi({"angie": [container()]})

        def check_predicate(description, predicate, timeout):
            self.assertFalse(predicate())
            api.current["angie"] = [{**container(), "Id": "replacement-container"}]
            self.assertTrue(predicate())

        with patch.object(DEPLOY, "wait_for", side_effect=check_predicate):
            DEPLOY.wait_service(api, "angie", previous_ids={"old-container"})

    def test_dry_run_never_contacts_easy1(self):
        rendered = {**plan(), "sourceSha256": "c" * 64, "sourceUrl": "https://codeload.github.com/public"}
        with patch.object(DEPLOY, "verify_release"), patch.object(DEPLOY, "source_plan", return_value=rendered), \
                patch.object(DEPLOY, "Easypanel") as api, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(DEPLOY.main(["--tag", TAG, "--commit", SHA, "--dry-run"]), 0)
        api.assert_not_called()

    def test_http_errors_never_include_body_or_credentials(self):
        error = urllib.error.HTTPError("https://example/api?secret=DO_NOT_LOG", 403, "DO_NOT_LOG", {}, io.BytesIO(b"DO_NOT_LOG"))
        with patch.object(DEPLOY.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(DEPLOY.DeploymentError) as caught:
                DEPLOY.request("https://example/api", token="DO_NOT_LOG")
        self.assertEqual(str(caught.exception), "HTTP request failed with status 403")

    def test_empty_mutation_response_is_successful_and_credentials_are_header_only(self):
        api = DEPLOY.Easypanel(DEPLOY.API_URL, "private-token")
        with patch.object(DEPLOY, "request", return_value=b"") as request:
            self.assertIsNone(api.post("deployAppService", "server"))
        request.assert_called_once_with(DEPLOY.API_URL + "/deployAppService", "POST",
                                        {"projectName": "betterframe", "serviceName": "server"}, "private-token", timeout=DEPLOY.TIMEOUT)


if __name__ == "__main__":
    unittest.main()
