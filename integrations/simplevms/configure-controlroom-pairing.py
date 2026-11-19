#!/usr/bin/env python3
"""Configure only the existing private control-room admin proxy for BF pairing.

Run as root from the released BF Git checkout after installing its matching native
image. No credentials are printed or passed as command-line arguments. Recorder
data, camera configuration, native credentials and recording policy are untouched.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time
from urllib.parse import urlsplit

BEGIN = "        # BEGIN BetterFrame private pairing administration\n"
END = "        # END BetterFrame private pairing administration\n"
BOUNDARY = '        respond @outsidePrivateNetworks "Private service" 403\n'
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")


class ConfigurationError(Exception):
    pass


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=240)
    if result.returncode:
        raise ConfigurationError("A deployment command failed; protected backups are retained")
    return result.stdout


def admin_origin(value):
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise ConfigurationError("Use the existing native HTTPS admin origin without a path")
    # Accessing port validates its syntax; normalize only the optional trailing slash.
    url.port
    return value.rstrip("/")


def render_caddy(original, origin, token):
    origin = admin_origin(origin)
    if not TOKEN.fullmatch(token):
        raise ConfigurationError("Invalid private proxy credential")
    marker = origin + " {\n"
    if original.count(marker) != 1:
        raise ConfigurationError("The native admin origin is not a unique existing Caddy site")
    start = original.index(marker)
    end = original.find("\n}", start)
    if end < 0:
        raise ConfigurationError("Native admin site boundary not found")
    site = original[start:end]
    if BEGIN in site:
        left = site.index(BEGIN)
        right = site.find(END, left)
        if right < 0:
            raise ConfigurationError("Incomplete managed pairing configuration")
        site = site[:left] + site[right + len(END):]
    if site.count(BOUNDARY) != 1 or "@outsidePrivateNetworks not remote_ip" not in site:
        raise ConfigurationError("The existing private-network admin boundary is required")
    paths = " ".join("/api/v1/plugins/bettercorp-betterframe/pairing/" + action for action in ("begin", "complete"))
    addition = BEGIN + f'''        @betterframePairing path {paths}
        handle @betterframePairing {{
            @betterframeWrongOrigin not header Origin {json.dumps(origin)}
            respond @betterframeWrongOrigin "Same-origin administration required" 403
            reverse_proxy unix//upstreams/ca/vms.sock {{
                header_up Host {{http.request.host}}
                header_up X-Forwarded-Host {{http.request.host}}
                header_up X-Forwarded-Proto {{scheme}}
                header_up X-Forwarded-For {{remote_host}}
                header_up X-BetterFrame-Pairing-Admin {json.dumps(token)}
                header_up -Forwarded
                header_up -X-Original-Host
                header_up -Original-Host
                header_up -CF-Connecting-Host
                header_up -CF-Original-Host
                header_up -CF-Connecting-IP
            }}
        }}
''' + END
    site = site.replace(BOUNDARY, BOUNDARY + addition)
    return original[:start] + site + original[end:]


def open_directory(path):
    if not Path(path).is_absolute():
        raise ConfigurationError("Deployment paths must be absolute")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory); directory = child
        return directory
    except Exception:
        os.close(directory); raise


def write_private(path, data, uid, gid, mode=0o600):
    directory = open_directory(path.parent); temporary = path.name + ".bf-" + secrets.token_hex(12)
    try:
        try:
            if stat.S_ISLNK(os.stat(path.name, dir_fd=directory, follow_symlinks=False).st_mode):
                raise ConfigurationError("Refusing a symlink deployment target")
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
        with os.fdopen(fd, "wb") as target:
            target.write(data); target.flush(); os.fchown(target.fileno(), uid, gid); os.fchmod(target.fileno(), mode); os.fsync(target.fileno())
        os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory); os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def remove_private(path):
    directory = open_directory(path.parent)
    try:
        try:
            os.unlink(path.name, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.fsync(directory)
    finally:
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args(); origin = admin_origin(args.origin)
    if os.geteuid() != 0 or not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise ConfigurationError("Root and the exact released BF revision are required")
    source = Path(__file__).resolve().parents[2]
    git = ("git", "-c", "safe.directory=" + str(source), "-C", str(source))
    if run(*git, "rev-parse", "HEAD").strip() != args.revision or run(*git, "status", "--porcelain").strip():
        raise ConfigurationError("Use the clean, exact released BF Git checkout")
    vms = json.loads(run("docker", "service", "inspect", "control-room_vms"))[0]["Spec"]
    edge = json.loads(run("docker", "service", "inspect", "control-room_edge"))[0]["Spec"]
    if vms["Mode"]["Replicated"]["Replicas"] != 1 or edge["Mode"]["Replicated"]["Replicas"] != 1:
        raise ConfigurationError("Expected the existing single-replica recorder and edge")
    image = vms["TaskTemplate"]["ContainerSpec"]["Image"]
    labels = json.loads(run("docker", "image", "inspect", image))[0]["Config"].get("Labels", {})
    if labels.get("com.betterframe.revision") != args.revision:
        raise ConfigurationError("Install the matching BF native image before configuring its proxy")
    uid, gid = map(int, vms["TaskTemplate"]["ContainerSpec"]["User"].split(":"))
    mounts = vms["TaskTemplate"]["ContainerSpec"].get("Mounts", [])
    if not any(m.get("Target") == "/data" and m.get("Source") == "/var/lib/controlroom/data/vms" for m in mounts):
        raise ConfigurationError("Unexpected recorder data mount")
    edge_mounts = {m["Target"]: m for m in edge["TaskTemplate"]["ContainerSpec"].get("Mounts", [])}
    caddy = Path(edge_mounts["/etc/caddy/Caddyfile"]["Source"])
    if caddy != Path("/var/lib/controlroom/edge/Caddyfile") or caddy.is_symlink():
        raise ConfigurationError("Unexpected private proxy configuration path")
    manifest = Path("/var/lib/controlroom-ca/private-ca.stack.json")
    folder = Path("/var/lib/controlroom/data/vms/betterframe")
    if folder.is_symlink():
        raise ConfigurationError("Unexpected recorder private directory")
    directory = open_directory(folder)
    try:
        os.fchown(directory, uid, gid); os.fchmod(directory, 0o700)
    finally:
        os.close(directory)
    proof = folder / "proxy-admin.json"
    if proof.is_symlink():
        raise ConfigurationError("Refusing a symlink proxy credential")
    original = caddy.read_bytes(); old_manifest = manifest.read_bytes()
    old_proof = proof.read_bytes() if proof.exists() else None
    token = json.loads(old_proof).get("token", "") if old_proof else secrets.token_urlsafe(32)
    updated = render_caddy(original.decode(), origin, token).encode()
    backup = Path("/var/backups/controlroom-bf-pairing") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup.mkdir(parents=True, mode=0o700)
    for name, data in (("Caddyfile", original), ("private-ca.stack.json", old_manifest), ("proxy-admin.json", old_proof)):
        if data is not None:
            write_private(backup / name, data, 0, 0)
    candidate = backup / "Caddyfile.candidate"; write_private(candidate, updated, 0, 0)
    root = edge_mounts["/etc/caddy/ca/root_ca.crt"]["Source"]
    edge_image = edge["TaskTemplate"]["ContainerSpec"]["Image"]
    run("docker", "run", "--rm", "--network", "none", "--mount", f"type=bind,src={candidate},dst=/etc/caddy/Caddyfile,readonly",
        "--mount", f"type=bind,src={root},dst=/etc/caddy/ca/root_ca.crt,readonly", "--entrypoint", "caddy", edge_image,
        "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile")
    metadata = caddy.stat(); manifest_metadata = manifest.stat()
    new_hash = hashlib.sha256(updated).hexdigest()
    previous_hash = edge["TaskTemplate"]["ContainerSpec"].get("Labels", {}).get("controlroom.proxy.config.sha256")
    changed = False
    try:
        if caddy.read_bytes() != original or manifest.read_bytes() != old_manifest:
            raise ConfigurationError("Deployment configuration changed concurrently")
        changed = True
        write_private(proof, (json.dumps({"origin": origin, "token": token}) + "\n").encode(), uid, gid)
        write_private(caddy, updated, metadata.st_uid, metadata.st_gid)
        run("docker", "service", "update", "--detach=true", "--container-label-add", "controlroom.proxy.config.sha256=" + new_hash, "--force", "control-room_edge")
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            ids = run("docker", "ps", "-q", "--filter", "label=com.docker.swarm.service.name=control-room_edge").split()
            if len(ids) == 1:
                task = json.loads(run("docker", "inspect", ids[0]))[0]
                if task["State"]["Running"] and task["Config"].get("Labels", {}).get("controlroom.proxy.config.sha256") == new_hash:
                    break
            time.sleep(2)
        else:
            raise ConfigurationError("Private admin proxy did not become ready")
        document = json.loads(old_manifest)
        document["services"]["edge"].setdefault("labels", {})["controlroom.proxy.config.sha256"] = new_hash
        if manifest.read_bytes() != old_manifest:
            raise ConfigurationError("Deployment manifest changed concurrently")
        write_private(manifest, (json.dumps(document, indent=2) + "\n").encode(), manifest_metadata.st_uid, manifest_metadata.st_gid, stat.S_IMODE(manifest_metadata.st_mode))
    except Exception:
        if changed:
            write_private(caddy, original, metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode))
            if old_proof is None:
                remove_private(proof)
            else:
                write_private(proof, old_proof, uid, gid)
            label = ("--container-label-add", "controlroom.proxy.config.sha256=" + previous_hash) if previous_hash else ("--container-label-rm", "controlroom.proxy.config.sha256")
            run("docker", "service", "update", "--detach=true", *label, "--force", "control-room_edge")
        raise
    print("Configured the existing private native admin origin:", origin)
    print("Pairing credentials remain private. Protected rollback backup:", backup)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Private pairing proxy configuration failed; inspect protected backups and retain the existing admin policy")
