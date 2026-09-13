#!/usr/bin/env python3
"""Offline regression tests for the easy1 release deployment boundary."""

import contextlib
import hashlib
import importlib.util
import io
import subprocess
import tarfile
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
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            data = PROXY.encode()
            member = tarfile.TarInfo(f"BetterFrame-{SHA}/deploy/angie/betterframe.docker.conf")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        archive_bytes = stream.getvalue()
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
            self.assertIn(f"FROM easypanel/betterframe/{service}:latest", dockerfile)
            self.assertNotIn("@COMMIT@", dockerfile)
        self.assertIn("betterframe_server:18080", rendered["proxy"])
        self.assertIn("betterframe_nodered:1880", rendered["proxy"])
        self.assertIn("return 307 https://frame-eu.betterportal.net$request_uri;", rendered["proxy"])

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
