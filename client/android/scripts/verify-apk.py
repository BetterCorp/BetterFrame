#!/usr/bin/env python3
"""Verify an APK's signature, pinned release identity, and version before upload."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

APPLICATION_ID = "cloud.betterportal.frame"


def fingerprint(value):
    normalized = value.strip().replace(":", "").upper()
    if not re.fullmatch(r"[0-9A-F]{64}", normalized):
        raise ValueError("certificate fingerprint must contain exactly 64 hexadecimal digits")
    return normalized


def tool_output(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        raise ValueError(f"could not execute {command[0]}: {error.strerror}") from error
    if result.returncode:
        raise ValueError(f"{Path(command[0]).name} rejected the APK (exit {result.returncode})")
    return result.stdout


def verify(apk, certificate_sha256, version_code, version_name, apksigner, aapt):
    expected_fingerprint = fingerprint(certificate_sha256)
    if version_code < 1 or version_code > 2_100_000_000:
        raise ValueError("version code must be between 1 and 2100000000")
    if not apk.is_file():
        raise ValueError("APK does not exist or is not a regular file")
    # Exit status verifies the cryptographic signature, not just certificate metadata.
    signatures = tool_output([apksigner, "verify", "--verbose", "--print-certs", str(apk)])
    signers = re.findall(r"^Signer #(\d+) certificate SHA-256 digest: (\S+)\s*$", signatures, re.M)
    signer_counts = re.findall(r"^Number of signers: (\d+)\s*$", signatures, re.M)
    if len(signers) != 1 or signers[0][0] != "1" or signer_counts != ["1"]:
        raise ValueError("APK must have exactly one signing certificate")
    actual_fingerprint = fingerprint(signers[0][1])
    if actual_fingerprint != expected_fingerprint:
        raise ValueError("APK signing certificate does not match the pinned release certificate")

    badging = tool_output([aapt, "dump", "badging", str(apk)])
    package_lines = re.findall(r"^package: (.+)$", badging, re.M)
    if len(package_lines) != 1:
        raise ValueError("could not uniquely read APK package metadata")
    attributes = dict(re.findall(r"(\w+)='([^']*)'", package_lines[0]))
    if attributes.get("name") != APPLICATION_ID:
        raise ValueError(f"APK application ID must be {APPLICATION_ID}")
    if attributes.get("versionCode") != str(version_code):
        raise ValueError("APK version code does not match the requested release")
    if attributes.get("versionName") != version_name:
        raise ValueError("APK version name does not match the requested release")
    digest = hashlib.sha256()
    with apk.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return {
        "applicationId": APPLICATION_ID,
        "versionCode": version_code,
        "versionName": version_name,
        "certificateSha256": actual_fingerprint,
        "apkSha256": digest.hexdigest(),
        "apkSizeBytes": apk.stat().st_size,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--certificate-sha256", required=True)
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--version-name", required=True)
    parser.add_argument("--apksigner", required=True)
    parser.add_argument("--aapt", required=True)
    parser.add_argument("--metadata", type=Path)
    args = parser.parse_args()
    try:
        if args.metadata and args.metadata.resolve() == args.apk.resolve():
            raise ValueError("metadata destination must not overwrite the APK")
        metadata = verify(args.apk, args.certificate_sha256, args.version_code,
                          args.version_name, args.apksigner, args.aapt)
        document = json.dumps(metadata, indent=2) + "\n"
        if args.metadata:
            args.metadata.write_text(document, encoding="utf-8")
        print(document, end="")
    except (ValueError, OSError) as error:
        print(f"APK verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
