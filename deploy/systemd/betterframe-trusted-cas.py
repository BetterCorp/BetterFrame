#!/usr/bin/python3
"""Bounded, root-owned CA reconciler. Never accepts paths or private keys from the player."""
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import stat
import subprocess
import tempfile

STATE = Path("/var/lib/betterframe/trusted-cas")
REQUEST = Path("/var/lib/betterframe/kiosk/trusted-cas-request.json")
CA_DIR = Path("/etc/pki/ca-trust/source/anchors") if Path("/usr/bin/update-ca-trust").is_file() else Path("/usr/local/share/ca-certificates")
MAX_REQUEST = 600 * 1024


def atomic(path, value):
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    fd, tmp = tempfile.mkstemp(prefix=".trusted-ca-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def revision(cas):
    return hashlib.sha256("\n".join(sorted(ca["fingerprint_sha256"] for ca in cas)).encode()).hexdigest()


def validate(cas, workdir):
    if not isinstance(cas, list) or len(cas) > 32:
        raise ValueError("At most 32 CA certificates are supported")
    result = {}
    for ca in cas:
        pem, fp = ca["pem"], ca["fingerprint_sha256"]
        if not isinstance(fp, str) or not re.fullmatch(r"[0-9a-f]{64}", fp) or fp in result:
            raise ValueError("Invalid or duplicate CA fingerprint")
        if not isinstance(pem, str) or len(pem.encode()) > 16384 or not re.fullmatch(r"-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----", pem.strip()):
            raise ValueError("One public PEM CA certificate is required")
        der = ssl.PEM_cert_to_DER_cert(pem.strip())
        if hashlib.sha256(der).hexdigest() != fp:
            raise ValueError("CA fingerprint mismatch")
        cert = Path(workdir) / "validate.pem"
        cert.write_text(pem)
        details = subprocess.run(["/usr/bin/openssl", "x509", "-in", str(cert), "-noout", "-ext", "basicConstraints", "-subject", "-issuer", "-nameopt", "RFC2253"], check=True, capture_output=True, text=True, timeout=10).stdout
        if not re.search(r"X509v3 Basic Constraints:[^\n]*\n\s*(?:[^\n]*, )?CA:TRUE", details):
            raise ValueError("Certificate must be a CA")
        subject = re.search(r"^subject=(.*)$", details, re.M)
        issuer = re.search(r"^issuer=(.*)$", details, re.M)
        if not subject or not issuer or subject[1] != issuer[1]:
            raise ValueError("Certificate must be a self-signed root CA")
        subprocess.run(["/usr/bin/openssl", "verify", "-check_ss_sig", "-CAfile", str(cert), str(cert)], check=True, capture_output=True, timeout=10)
        result[fp] = ssl.DER_cert_to_PEM_cert(der).encode()
    return result


def reconcile(cas, state_dir=STATE, ca_dir=CA_DIR, update=None):
    """The privileged entry point validates the whole set before any trust mutation."""
    state_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    ca_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    journal = state_dir / "ownership.json"
    previous = json.loads(journal.read_text()) if journal.exists() else {"owned": [], "desired": [], "dirty": False}
    with tempfile.TemporaryDirectory(dir=state_dir) as workdir:
        validated = validate(cas, workdir)
    owned = set(previous["owned"])
    # Record ownership BEFORE copying a new file; a crash is safely retryable.
    for fp in validated:
        target = ca_dir / ("betterframe-" + fp + ".crt")
        if target.is_symlink():
            raise ValueError("Refusing a symlink in the managed CA directory")
        if target.exists() and target.read_bytes() != validated[fp]:
            raise ValueError("Managed CA path contains an unexpected certificate")
        if not target.exists():
            owned.add(fp)
    for fp in owned:
        if not re.fullmatch(r"[0-9a-f]{64}", fp):
            raise ValueError("Corrupt CA ownership journal")
    atomic(journal, {"owned": sorted(owned), "desired": cas, "dirty": True})
    changed = bool(previous.get("dirty")) or revision(previous.get("desired", [])) != revision(cas)
    for fp in owned:
        target = ca_dir / ("betterframe-" + fp + ".crt")
        if target.is_symlink():
            raise ValueError("Refusing a symlink in the managed CA directory")
        if fp in validated:
            if not target.exists() or target.read_bytes() != validated[fp]:
                atomic(target, validated[fp]); changed = True
        elif target.exists():
            target.unlink(); changed = True
    if changed:
        (update or (lambda: subprocess.run((["/usr/bin/update-ca-trust", "extract"] if Path("/usr/bin/update-ca-trust").is_file() else ["/usr/sbin/update-ca-certificates"]), check=True, capture_output=True, timeout=60)))()
    atomic(journal, {"owned": sorted(owned.intersection(validated)), "desired": cas, "dirty": False})
    return changed


def read_request(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REQUEST:
            raise ValueError("Invalid CA request file")
        raw = stream.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError("CA request is too large")
        return json.loads(raw), info.st_ino


def restart_player():
    subprocess.run(["/usr/bin/systemctl", "try-restart", "--no-block", "betterframe-kiosk.service"], check=False, timeout=10)
    # Standalone desktop installs use the user's graphical service.
    config = Path("/etc/betterframe/linux-install")
    if config.is_file():
        fields = config.read_text().split()
        if len(fields) >= 2 and fields[1] == "desktop" and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_-]*[$]?", fields[0]):
            import pwd
            uid = pwd.getpwnam(fields[0]).pw_uid
            if uid > 0:
                subprocess.run(["/usr/sbin/runuser", "-u", fields[0], "--", "/usr/bin/env", "XDG_RUNTIME_DIR=/run/user/" + str(uid), "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + str(uid) + "/bus", "/usr/bin/systemctl", "--user", "try-restart", "--no-block", "betterframe.service"], check=False, timeout=10)


def main():
    STATE.mkdir(mode=0o755, parents=True, exist_ok=True)
    inode = None
    cas = []
    try:
        if REQUEST.exists() or REQUEST.is_symlink():
            body, inode = read_request(REQUEST)
            cas = body["trusted_cas"]
        elif (STATE / "ownership.json").exists():
            cas = json.loads((STATE / "ownership.json").read_text())["desired"]
        changed = reconcile(cas)
        atomic(STATE / "status.json", {"revision": revision(cas), "state": "applied", "message": ""})
        if inode and REQUEST.lstat().st_ino == inode:
            REQUEST.unlink()
        if changed:
            # Nonblocking: this unit also orders restoration before kiosk startup.
            restart_player()
    except Exception as error:
        try:
            desired_revision = revision(cas)
        except Exception:
            desired_revision = hashlib.sha256(b"").hexdigest()
        atomic(STATE / "status.json", {"revision": desired_revision, "state": "error", "message": ("CA provisioning failed: " + str(error))[:1024]})
        if inode and REQUEST.exists() and REQUEST.lstat().st_ino == inode:
            REQUEST.unlink()
        raise


if __name__ == "__main__":
    main()
