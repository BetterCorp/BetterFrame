#!/usr/bin/env python3
"""Execute the real workflow validation steps without building or publishing."""

import os
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
            }
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
        ]:
            with self.subTest(version=version):
                result, output = self.validate(self.release, version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"channel={channel}\n", output)
                self.assertIn(f"version={version}\n", output)
                result, output = self.validate(self.android, version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"BF_ANDROID_VERSION_NAME={version}\n", output)

    def test_unversioned_and_malformed_tags_are_rejected(self):
        for version in [
            "", "dev", "master", "latest", "01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-alpha", "1.2.3-beta.",
            "1.2.3-dev..hash", "1.2.3-alpha.1.", "1.2.3-rc.1", "1.2.3-alpha.1/evil",
            "1.2.3\nextra", "1.2.3-alpha.$(false)",
        ]:
            for workflow, script in [("release", self.release), ("android", self.android)]:
                with self.subTest(version=version, workflow=workflow):
                    result, _ = self.validate(script, version)
                    self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
