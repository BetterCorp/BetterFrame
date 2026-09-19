#!/usr/bin/env python3
"""Non-destructive installer checks: no packages, services, or host files changed."""
import base64
import hashlib
import os
from pathlib import Path
import pwd
import grp
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SetupTests(unittest.TestCase):
    def shell(self, body, check=True):
        return subprocess.run(['bash', '-c', f'source {shlex.quote(str(ROOT / "setup.sh"))}\n{body}'],
                              text=True, capture_output=True, check=check)

    def test_arguments(self):
        self.assertEqual(self.shell('parse_args --yes --mode desktop --no-start; echo "$MODE $START $ASSUME_YES"').stdout.strip(), 'desktop 0 1')
        for args in ['--mode invalid', '--binary', '--version 1.0.1 --binary /tmp/app']:
            self.assertNotEqual(self.shell(f'parse_args {args}', check=False).returncode, 0)

    def test_distro_packages(self):
        for distro, like, manager, package in [('ubuntu', 'debian', 'apt-get', 'libwebkitgtk-6.0-4'),
                                               ('fedora', '', 'dnf', 'webkitgtk6.0')]:
            result = self.shell(f'DISTRO_ID={distro}; DISTRO_LIKE="{like}"; select_packages; echo "$PACKAGE_MANAGER ${{PACKAGES[*]}}"')
            self.assertIn(manager, result.stdout)
            self.assertIn(package, result.stdout)
            self.assertNotIn('cage', result.stdout)
        self.assertIn('cage', self.shell('DISTRO_ID=ubuntu; DISTRO_LIKE=debian; MODE=dedicated; select_packages; echo "${PACKAGES[*]}"').stdout)
        self.assertNotEqual(self.shell('DISTRO_ID=arch; DISTRO_LIKE=; select_packages', check=False).returncode, 0)

    def test_target(self):
        self.assertIn('betterframe-pc-x86_64', self.shell('select_target x86_64; echo "$TARGET"').stdout)
        self.assertIn('rpi5', self.shell('select_target aarch64 "Raspberry Pi 5 Model B"; echo "$TARGET"').stdout)
        self.assertNotEqual(self.shell('select_target aarch64 Generic', check=False).returncode, 0)

    def test_signed_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            artifact = p / 'app'
            artifact.write_bytes(b'test release bytes')
            digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
            (p / 'app.sha256').write_text(digest + '\n')
            (p / 'digest').write_text(digest)
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'Ed25519', '-out', str(p / 'private')], check=True, capture_output=True)
            subprocess.run(['openssl', 'pkey', '-in', str(p / 'private'), '-pubout', '-out', str(p / 'public')], check=True, capture_output=True)
            subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(p / 'private'), '-rawin', '-in', str(p / 'digest'), '-out', str(p / 'signature')], check=True, capture_output=True)
            (p / 'app.sig').write_text(base64.urlsafe_b64encode((p / 'signature').read_bytes()).decode().rstrip('='))
            cmd = f'TRUST_KEY={shlex.quote(str(p / "public"))}; verify_download {shlex.quote(str(artifact))}'
            self.shell(cmd)
            artifact.write_bytes(b'tampered')
            self.assertNotEqual(self.shell(cmd, check=False).returncode, 0)
            # Even an updated checksum must not make a modified artifact trusted.
            (p / 'app.sha256').write_text(hashlib.sha256(artifact.read_bytes()).hexdigest())
            self.assertNotEqual(self.shell(cmd, check=False).returncode, 0)

    def test_atomic_install_and_repeat_preserve_previous(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'app').write_bytes(b'old')
            (p / 'candidate').write_bytes(b'new')
            user = pwd.getpwuid(os.getuid()).pw_name
            group = grp.getgrgid(os.getgid()).gr_name
            cmd = f'BIN={tmp}/app; STAGING={tmp}; INSTALL_USER={shlex.quote(user)}; USER_GROUP={shlex.quote(group)}; install_app_binary'
            self.shell(cmd)
            self.assertEqual((p / 'app').read_bytes(), b'new')
            self.assertEqual((p / 'app.prev').read_bytes(), b'old')
            self.shell(cmd)
            self.assertEqual((p / 'app.prev').read_bytes(), b'old')
            self.assertTrue(os.access(p / 'app', os.X_OK))

    def test_incompatible_binary_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'app'
            p.write_text('#!/bin/sh\nexit 0\n')
            self.assertNotEqual(self.shell(f'TARGET=betterframe-pc-x86_64; check_binary {p}', check=False).returncode, 0)
            shutil.copy('/bin/true', p)
            self.assertNotEqual(self.shell(f'TARGET=betterframe-rpi5-aarch64; check_binary {p}', check=False).returncode, 0)
            self.assertNotEqual(self.shell(f'TARGET=betterframe-pc-x86_64; ldd() {{ echo "libmissing.so => not found"; }}; check_binary {p}', check=False).returncode, 0)

    def test_service_restart_contract(self):
        for command in ['write_desktop_unit', 'INSTALL_USER=kiosk; USER_ID=1000; write_dedicated_unit']:
            unit = self.shell(command).stdout
            self.assertIn('Restart=always', unit)
            self.assertIn('BF_ENABLE_OS_OTA=0', unit)
            self.assertIn('/opt/betterframe/kiosk/betterframe-kiosk', unit)
            self.assertNotIn('reboot', unit)
        updater = (ROOT / 'client/src/platform/linux/firmware.rs').read_text()
        self.assertNotIn('.arg("reboot")', updater)
        self.assertNotIn('Command::new', updater)
        self.assertIn('on_progress("Restarting app", 100)', updater)
        unit = (ROOT / 'deploy/systemd/betterframe-kiosk.service').read_text()
        self.assertNotIn('Action=reboot', unit)
        self.assertIn('Restart=always', unit)

    def test_rollback_after_failed_candidate_starts(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            script = (ROOT / 'deploy/systemd/betterframe-firmware-rollback.sh').read_text()
            script = script.replace('/opt/betterframe/kiosk/betterframe-kiosk', f'{tmp}/app').replace('/var/lib/betterframe/kiosk/', f'{tmp}/')
            (p / 'rollback.sh').write_text(script)
            (p / 'app').write_text('broken')
            (p / 'app.prev').write_text('working')
            (p / 'firmware-applying.json').write_text('{}')
            for _ in range(4):
                subprocess.run(['bash', str(p / 'rollback.sh')], check=True, capture_output=True)
            self.assertEqual((p / 'app').read_text(), 'working')
            self.assertFalse((p / 'firmware-applying.json').exists())


if __name__ == '__main__':
    unittest.main()
