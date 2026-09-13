#!/usr/bin/env python3
"""Execute the real workflow validation steps without building or publishing."""

import os
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def workflow_script(filename, step):
    lines = (ROOT / ".github/workflows" / filename).read_text().splitlines()
    index = lines.index(f"      - name: {step}")
    index = lines.index("        run: |", index) + 1
    script = []
    for line in lines[index:]:
        if line and not line.startswith("          "):
            break
        script.append(line[10:] if line else "")
    return "\n".join(script)


class ReleaseVersionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.release = workflow_script("release.yml", "Compute version / channel / tag")
        cls.android = workflow_script("android-release.yml", "Validate release identity and version")
        cls.easy1 = workflow_script("easy1-deploy.yml", "Resolve released commit")
        spec = importlib.util.spec_from_file_location("easy1_deploy", ROOT / "deploy/easy1/deploy.py")
        cls.deployment = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.deployment)
        cls.commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()

    def validate(self, script, version):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            output.touch()
            env = {
                **os.environ,
                "GITHUB_REF": "refs/tags/v" + version,
                "GITHUB_SHA": self.commit,
                "GITHUB_RUN_NUMBER": "42",
                "GITHUB_OUTPUT": str(output),
                "GITHUB_ENV": str(output),
                "RELEASE_REF": self.commit,
                "RELEASE_TAG": "v" + version,
                "RELEASE_VERSION": version,
                "RELEASE_RUN": "42",
                "VERSION_OFFSET": "0",
                "CERTIFICATE_SHA256": "A" * 64,
                "TAG": "v" + version,
                "EXPECTED_COMMIT": self.commit,
            }
            if script == self.easy1:
                # Simulate an existing matching tag without creating repository
                # refs. The actual shell validator runs before this resolution.
                script = 'git() { test "$1" = rev-parse || return 1; echo "$GITHUB_SHA"; }\n' + script
            result = subprocess.run(["bash", "-c", script], cwd=ROOT, env=env,
                                    capture_output=True, text=True, check=False)
            return result, output.read_text()

    def test_release_channels_and_android_accept_the_same_versions(self):
        for version, channel in [
            ("1.2.3", "stable"),
            ("0.0.1-alpha.1", "dev"),
            ("1.2.3-beta.12", "beta"),
            ("1.2.3-dev.001abc0", "dev"),
            ("1.2.3-dev.build-beta.1", "dev"),
            ("1.2.3-alpha.build-beta", "dev"),
            ("1.2.3-beta.0", "beta"),
            ("1.2.3-beta.10", "beta"),
            ("1.2.3-beta.001abc.0", "beta"),
        ]:
            with self.subTest(version=version):
                result, output = self.validate(self.release, version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"channel={channel}\n", output)
                self.assertIn(f"version={version}\n", output)
                result, output = self.validate(self.android, version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"BF_ANDROID_VERSION_NAME={version}\n", output)
                result, output = self.validate(self.easy1, version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"commit={self.commit}\n", output)
                self.deployment.validate_inputs("v" + version, self.commit)

    def test_unversioned_and_malformed_tags_are_rejected(self):
        for version in [
            "", "dev", "master", "latest", "01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-alpha", "1.2.3-beta.",
            "1.2.3-dev..hash", "1.2.3-alpha.1.", "1.2.3-rc.1", "1.2.3-alpha.1/evil",
            "1.2.3\nextra", "1.2.3-alpha.$(false)",
            "1.2.3-beta.01", "1.2.3-alpha.00", "1.2.3-dev.0123456",
            "1.2.3-beta.build.01", "1.2.3-alpha.1.00",
        ]:
            for workflow, script in [("release", self.release), ("android", self.android), ("easy1", self.easy1)]:
                with self.subTest(version=version, workflow=workflow):
                    result, _ = self.validate(script, version)
                    self.assertNotEqual(result.returncode, 0)
            with self.subTest(version=version, workflow="deployment-python"), self.assertRaises(self.deployment.DeploymentError):
                self.deployment.validate_inputs("v" + version, self.commit)

    def test_zero_padded_prerelease_cannot_overwrite_same_commit_version(self):
        containers = [{"Labels": {"org.opencontainers.image.revision": self.commit,
                                  "org.opencontainers.image.version": "1.2.3-beta.1"}}]
        with self.assertRaisesRegex(self.deployment.DeploymentError, "version label is missing or invalid"):
            self.deployment.prevent_stale_deployment(containers, self.commit, "1.2.3-beta.01")

    def test_automatic_dev_release_handles_zero_leading_numeric_git_sha(self):
        script = 'GITHUB_REF=refs/heads/master\ngit() { case "$1" in rev-parse) echo 0123456 ;; tag) echo v1.2.3 ;; *) return 1 ;; esac; }\n' + self.release
        result, output = self.validate(script, "unused")
        self.assertEqual(result.returncode, 0, result.stderr)
        version = "1.2.4-dev.g0123456"
        self.assertIn(f"version={version}\n", output)
        self.deployment.validate_inputs("v" + version, self.commit)
        for validation in (self.android, self.easy1):
            result, _ = self.validate(validation, version)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
