"""Exercise release verification failures without requiring an Android SDK."""

import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("verify_apk", Path(__file__).with_name("verify-apk.py"))
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
CERTIFICATE = "AB" * 32
SIGNATURE = f"Verifies\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: {CERTIFICATE.lower()}\n"
PACKAGE = "package: name='cloud.betterportal.frame' versionCode='42' versionName='1.2.3' platformBuildVersionName='15'\n"


class VerifyApkTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.apk = Path(self.temporary.name) / "release.apk"
        self.apk.write_bytes(b"fixture APK bytes")

    def verify(self, signature=SIGNATURE, package=PACKAGE, status=0):
        outputs = [subprocess.CompletedProcess([], status, signature, ""),
                   subprocess.CompletedProcess([], 0, package, "")]
        with patch.object(VERIFY.subprocess, "run", side_effect=outputs):
            return VERIFY.verify(self.apk, CERTIFICATE, 42, "1.2.3", "apksigner", "aapt")

    def test_metadata_describes_verified_file(self):
        metadata = self.verify()
        self.assertEqual(metadata["applicationId"], "cloud.betterportal.frame")
        self.assertEqual(metadata["certificateSha256"], CERTIFICATE)
        self.assertEqual(metadata["apkSha256"], hashlib.sha256(self.apk.read_bytes()).hexdigest())
        self.assertEqual(metadata["versionCode"], 42)

    def test_bad_signature_fails_even_if_tool_prints_expected_certificate(self):
        with self.assertRaisesRegex(ValueError, "apksigner rejected"):
            self.verify(status=1)

    def test_valid_signature_from_another_key_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "does not match the pinned"):
            self.verify(signature=SIGNATURE.replace(CERTIFICATE.lower(), "cd" * 32))

    def test_co_signed_apk_is_rejected_even_if_expected_key_is_present(self):
        co_signed = SIGNATURE.replace("Number of signers: 1", "Number of signers: 2")
        co_signed += f"Signer #2 certificate SHA-256 digest: {'cd' * 32}\n"
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.verify(signature=co_signed)

    def test_missing_signer_metadata_fails_closed(self):
        for output in ("Verifies\n", SIGNATURE.replace("Number of signers: 1\n", "")):
            with self.subTest(output=output), self.assertRaisesRegex(ValueError, "exactly one"):
                self.verify(signature=output)

    def test_previous_or_debug_application_id_is_rejected(self):
        for app_id in ("net.bettercorp.betterframe.viewer", "cloud.betterportal.frame.debug"):
            with self.subTest(app_id=app_id), self.assertRaisesRegex(ValueError, "application ID"):
                self.verify(package=PACKAGE.replace("cloud.betterportal.frame", app_id))

    def test_mismatched_version_is_rejected(self):
        for package in (PACKAGE.replace("versionCode='42'", "versionCode='41'"),
                        PACKAGE.replace("versionName='1.2.3'", "versionName='1.2.2'")):
            with self.subTest(package=package), self.assertRaisesRegex(ValueError, "does not match the requested"):
                self.verify(package=package)

    def test_missing_or_ambiguous_package_metadata_is_rejected(self):
        for package in ("", PACKAGE + PACKAGE):
            with self.subTest(package=package), self.assertRaisesRegex(ValueError, "uniquely read"):
                self.verify(package=package)


if __name__ == "__main__":
    unittest.main()
