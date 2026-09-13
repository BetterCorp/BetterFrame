#!/usr/bin/env python3
"""Deploy one published BetterFrame release to the existing easy1 installation.

API responses may contain credentials. Never print response bodies or exception
messages from HTTP, subprocesses, or JSON parsers. Progress is allowlisted below.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "BetterCorp/BetterFrame"
PROJECT = "betterframe"
API_URL = "https://easy1.eu2.betterweb.co.za/api"
PUBLIC_URL = "https://frame-eu.betterportal.net"
PROXY_PATH = "/etc/nginx/conf.d/default.conf"
VERSION = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:alpha|beta|dev)\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")
COMMIT = re.compile(r"[0-9a-f]{40}")
TIMEOUT = 1200


class DeploymentError(Exception):
    """Only locally authored, non-sensitive messages belong in this exception."""


def validate_inputs(tag, commit):
    if not VERSION.fullmatch(tag):
        raise DeploymentError("tag must be a version with an optional alpha, beta, or dev suffix")
    if not COMMIT.fullmatch(commit):
        raise DeploymentError("commit must be a full lowercase 40-character Git SHA")


def github(path):
    try:
        response = subprocess.run(["gh", "api", f"repos/{REPOSITORY}/{path}"],
                                  capture_output=True, text=True, timeout=60, check=False)
        if response.returncode:
            raise DeploymentError("GitHub release verification request failed")
        return json.loads(response.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise DeploymentError("GitHub release verification could not complete") from None


def verify_release(tag, commit):
    validate_inputs(tag, commit)
    release = github(f"releases/tags/{tag}")
    if (not isinstance(release, dict) or release.get("draft") is not False
            or not release.get("published_at") or release.get("tag_name") != tag):
        raise DeploymentError("tag must identify a published GitHub release")
    reference = github(f"git/ref/tags/{tag}")
    target = reference.get("object", {}) if isinstance(reference, dict) else {}
    # Annotated tags can point at another tag; refuse unreasonable chains.
    for _ in range(5):
        if target.get("type") != "tag":
            break
        object_sha = target.get("sha", "")
        if not COMMIT.fullmatch(object_sha):
            raise DeploymentError("release tag has an invalid Git object")
        annotated = github(f"git/tags/{object_sha}")
        target = annotated.get("object", {}) if isinstance(annotated, dict) else {}
    if target.get("type") != "commit" or target.get("sha") != commit:
        raise DeploymentError("published release tag does not match the requested commit")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # In particular, never forward an Easypanel bearer token to another URL.
        raise DeploymentError("unexpected HTTP redirect")


def request(url, method="GET", data=None, token=None, limit=8 * 1024 * 1024, timeout=60):
    headers = {"Accept": "application/json", "User-Agent": "BetterFrame-release-deploy"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = None
    if data is not None:
        payload = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    try:
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(urllib.request.Request(url, data=payload, headers=headers, method=method),
                         timeout=timeout) as response:
            body = response.read(limit + 1)
        if len(body) > limit:
            raise DeploymentError("HTTP response exceeded the size limit")
        return body
    except urllib.error.HTTPError as error:
        raise DeploymentError(f"HTTP request failed with status {error.code}") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise DeploymentError("HTTP request failed") from None


def json_body(body):
    try:
        return json.loads(body) if body else None
    except (ValueError, UnicodeError):
        raise DeploymentError("HTTP response was not valid JSON") from None


class Easypanel:
    def __init__(self, url, token):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment or parsed.path.rstrip("/") != "/api"):
            raise DeploymentError("EASY1_API_URL must be an HTTPS API URL without credentials or query parameters")
        if not token or "\n" in token or "\r" in token:
            raise DeploymentError("EASY1_API_TOKEN is required")
        self.url = url.rstrip("/")
        self.token = token

    def get(self, procedure, **values):
        return json_body(request(f"{self.url}/{procedure}?{urllib.parse.urlencode(values)}", token=self.token))

    def post(self, procedure, service, **values):
        body = {"projectName": PROJECT, "serviceName": service, **values}
        # Successful mutations may return an empty body, not JSON.
        if procedure == "deployAppService":
            return json_body(request(f"{self.url}/{procedure}", "POST", body, self.token, timeout=TIMEOUT))
        return json_body(request(f"{self.url}/{procedure}", "POST", body, self.token))


def source_plan(tag, commit):
    validate_inputs(tag, commit)
    archive_url = f"https://codeload.github.com/{REPOSITORY}/tar.gz/{commit}"
    archive = request(archive_url, limit=128 * 1024 * 1024)
    checksum = hashlib.sha256(archive).hexdigest()
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            member = bundle.getmember(f"BetterFrame-{commit}/deploy/angie/betterframe.docker.conf")
            if not member.isfile() or member.size > 1024 * 1024:
                raise DeploymentError("released proxy configuration is not a regular bounded file")
            proxy = bundle.extractfile(member).read().decode("utf-8")
    except (tarfile.TarError, KeyError, UnicodeError, OSError):
        raise DeploymentError("source archive does not contain the released proxy configuration") from None
    # Adapt only Compose DNS names. Retain the released canonical-host redirect.
    proxy, server_count = re.subn(r"\bserver server:(1808[012]);", r"server betterframe_server:\1;", proxy)
    proxy, nodered_count = re.subn(r"\bserver nodered:1880;", "server betterframe_nodered:1880;", proxy)
    if server_count != 3 or nodered_count != 1:
        raise DeploymentError("released proxy upstreams do not match the supported topology")
    dockerfiles = {}
    for service in ("server", "nodered"):
        template = Path(__file__).with_name(f"{service}.Dockerfile").read_text()
        dockerfiles[service] = (template.replace("@VERSION@", tag[1:]).replace("@COMMIT@", commit)
                               .replace("@SOURCE_SHA256@", checksum))
    return {"tag": tag, "commit": commit, "version": tag[1:], "sourceSha256": checksum,
            "sourceUrl": archive_url, "dockerfiles": dockerfiles, "proxy": proxy}


def healthy_containers(containers, commit=None, version=None):
    if not isinstance(containers, list) or not containers:
        return False
    for container in containers:
        if not isinstance(container, dict):
            return False
        if container.get("State") != "running" or container.get("Health", {}).get("Status") != "healthy":
            return False
        labels = container.get("Labels", {})
        if commit is not None and labels.get("org.opencontainers.image.revision") != commit:
            return False
        if version is not None and labels.get("org.opencontainers.image.version") != version:
            return False
    return True


def wait_for(description, predicate, timeout=TIMEOUT):
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            print(f"Verified {description}.", flush=True)
            return
        if time.monotonic() >= deadline:
            raise DeploymentError(f"timed out waiting for {description}")
        time.sleep(10)


def wait_service(api, service, commit=None, version=None, timeout=TIMEOUT, previous_ids=None):
    def ready():
        containers = api.get("getDockerContainers", service=f"{PROJECT}_{service}")
        if not healthy_containers(containers, commit, version):
            return False
        if previous_ids is not None:
            # A restart can return before Swarm replaces the old healthy task.
            if any(not container.get("Id") or container["Id"] in previous_ids for container in containers):
                return False
        return True

    wait_for(f"{service} health and deployed revision" if commit else f"{service} health",
             ready, timeout)


def public_ready(version):
    try:
        health = json_body(request(f"{PUBLIC_URL}/healthz"))
        ready = json_body(request(f"{PUBLIC_URL}/readyz"))
        deployed = json_body(request(f"{PUBLIC_URL}/version"))
        return (isinstance(health, dict) and health.get("status") == "ok"
                and isinstance(ready, dict) and ready.get("status") == "ready"
                and isinstance(deployed, dict) and deployed.get("version") == version)
    except DeploymentError:
        return False


def proxy_mount(api):
    service = api.get("inspectAppService", projectName=PROJECT, serviceName="angie")
    if not isinstance(service, dict):
        raise DeploymentError("could not inspect the proxy service")
    matches = [(index, mount) for index, mount in enumerate(service.get("mounts", []))
               if isinstance(mount, dict) and mount.get("mountPath") == PROXY_PATH]
    if len(matches) != 1 or matches[0][1].get("type") != "file":
        raise DeploymentError("proxy must have exactly one existing file mount at the expected path")
    return matches[0]


def version_precedence(version):
    """SemVer precedence for the version formats accepted by this deployment."""
    if not isinstance(version, str):
        raise DeploymentError("deployment version label is missing or invalid")
    match = VERSION.fullmatch("v" + version)
    if not match:
        raise DeploymentError("deployment version label is missing or invalid")
    core = tuple(int(match.group(index)) for index in (1, 2, 3))
    prerelease = version.partition("-")[2]
    # A stable version outranks its prereleases. Numeric identifiers compare as
    # integers and sort before non-numeric identifiers; tuple prefix ordering
    # makes a shorter otherwise-equal prerelease sort before the longer one.
    identifiers = tuple((0, int(part)) if part.isdigit() else (1, part)
                        for part in prerelease.split(".")) if prerelease else ()
    return core, not prerelease, identifiers


def prevent_stale_deployment(containers, commit, version):
    if not isinstance(containers, list):
        raise DeploymentError("could not inspect current deployment revisions")
    requested_precedence = version_precedence(version)
    for container in containers:
        labels = container.get("Labels", {}) if isinstance(container, dict) else {}
        if labels.get("org.opencontainers.image.revision") == commit:
            current_precedence = version_precedence(labels.get("org.opencontainers.image.version"))
            if requested_precedence < current_precedence:
                raise DeploymentError("requested release version is older than the deployed version at this commit; refusing stale deployment")
    revisions = {container.get("Labels", {}).get("org.opencontainers.image.revision")
                 for container in containers if isinstance(container, dict)}
    for current in revisions:
        if not current or current == commit:
            continue
        if not isinstance(current, str) or not COMMIT.fullmatch(current):
            raise DeploymentError("current deployment has an invalid revision label")
        try:
            result = subprocess.run(["git", "merge-base", "--is-ancestor", commit, current],
                                    capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise DeploymentError("could not check deployment ancestry") from None
        if result.returncode == 0:
            raise DeploymentError("requested release is older than the deployed revision; refusing stale deployment")
        if result.returncode != 1:
            raise DeploymentError("deployment ancestry check needs complete local Git history")


def deploy(api, plan):
    # Preflight all targets and the mount before altering any service.
    for service in ("server", "nodered"):
        inspected = api.get("inspectAppService", projectName=PROJECT, serviceName=service)
        if not isinstance(inspected, dict) or inspected.get("name") != service or inspected.get("projectName") != PROJECT:
            raise DeploymentError("deployment service preflight failed")
        containers = api.get("getDockerContainers", service=f"{PROJECT}_{service}")
        prevent_stale_deployment(containers, plan["commit"], plan["version"])
    proxy_mount(api)
    for service in ("server", "nodered"):
        containers = api.get("getDockerContainers", service=f"{PROJECT}_{service}")
        prevent_stale_deployment(containers, plan["commit"], plan["version"])
        if healthy_containers(containers, plan["commit"], plan["version"]):
            print(f"{service} already runs the healthy requested release; skipping rebuild.", flush=True)
            if service == "server":
                wait_for("regional server readiness and version", lambda: public_ready(plan["version"]), timeout=120)
            continue
        print(f"Deploying {service} for {plan['tag']}.", flush=True)
        deadline = time.monotonic() + TIMEOUT
        api.post("updateAppSourceDockerfile", service, dockerfile=plan["dockerfiles"][service])
        api.post("deployAppService", service)
        wait_service(api, service, plan["commit"], plan["version"], timeout=max(0, deadline - time.monotonic()))
        if service == "server":
            wait_for("regional server readiness and version", lambda: public_ready(plan["version"]), timeout=120)
    # Re-read the mount index after builds, in case an operator edited mounts.
    index, mount = proxy_mount(api)
    if mount.get("content") != plan["proxy"]:
        api.post("updateMount", "angie", index=index,
                 values={"type": "file", "mountPath": PROXY_PATH, "content": plan["proxy"]})
    containers = api.get("getDockerContainers", service=f"{PROJECT}_angie")
    if not isinstance(containers, list) or any(not isinstance(item, dict) or not item.get("Id") for item in containers):
        raise DeploymentError("could not identify current proxy containers")
    previous_ids = {container["Id"] for container in containers}
    # Always restart: a previous attempt may have saved the mount but failed to
    # restart, so matching stored configuration alone cannot prove loaded state.
    api.post("restartAppService", "angie")
    wait_service(api, "angie", timeout=120, previous_ids=previous_ids)
    wait_for("regional release health", lambda: public_ready(plan["version"]), timeout=120)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        verify_release(args.tag, args.commit)
        plan = source_plan(args.tag, args.commit)
        print(json.dumps({key: plan[key] for key in ("tag", "commit", "sourceSha256", "sourceUrl")}), flush=True)
        if args.dry_run:
            print("Dry run verified the published release and rendered both Dockerfiles and the proxy. No easy1 requests were made.")
            return 0
        api = Easypanel(os.environ.get("EASY1_API_URL", API_URL), os.environ.get("EASY1_API_TOKEN", ""))
        # Revalidate immediately before the first remote mutation.
        verify_release(args.tag, args.commit)
        deploy(api, plan)
        print(f"Deployed and verified {args.tag} on easy1.")
        return 0
    except DeploymentError as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
    except Exception:
        # Last-resort boundary: no traceback can leak remote configuration.
        print("Deployment failed: unexpected local or remote response; no sensitive details logged.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
