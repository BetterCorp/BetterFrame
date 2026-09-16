"""Host-only regression tests; reboot, D-Bus and systemd are always mocked."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[2]


class RebootGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'calls'
        self.status = self.root / 'status'
        shutil.copyfile(DEPLOY / 'rauc/reboot-after-install.sh', self.root / 'guard.sh')
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        BF_REBOOT_STATUS_FILE=str(self.status), BF_REBOOT_GRACE_SECONDS='0',
                        BF_REBOOT_WAIT_SECONDS='10', CALLS=str(self.log),
                        COUNT=str(self.root / 'count'), MODE='success', READY_FILE=str(self.root / 'ready'),
                        BF_RAUC_SYSTEM_CONF=str(self.root / 'system.conf'),
                        BF_RAUC_ACTIVATION_STATE=str(self.root / 'slot-state'))
        (self.root / 'system.conf').write_text('data-directory=/var/lib/betterframe/rauc\n')
        (self.root / 'slot-state').write_text('pending=B\n')
        self.script(self.root / 'state.sh', 'echo migrate >> "$CALLS"')
        self.script(self.bin / 'busctl', '''
case "${*: -1}" in
  de.pengutronix.rauc)
    [ "$MODE" != restart ] || { echo 's ":1.99"'; exit; }
    echo 's ":1.42"' ;;
  Operation)
    n=$(cat "$COUNT" 2>/dev/null || echo 0); echo $((n+1)) > "$COUNT"
    if [ "$MODE" = timeout ] || [ "$n" = 0 ]; then echo 's "installing"'; else echo 's "idle"'; fi ;;
  LastError)
    if [ "$MODE" = failed ]; then echo 's "activation failed"'; else echo 's ""'; fi ;;
  GetPrimary)
    if [ "$MODE" = wrongslot ]; then echo 's "rootfs.0"'; else echo 's "rootfs.1"'; fi ;;
  *) exit 2 ;;
esac''')
        self.script(self.bin / 'systemd-notify', '[ "$MODE" != notify_failure ]; [ "$*" = --ready ]; echo ready > "$READY_FILE"')
        self.script(self.bin / 'systemctl', 'echo "systemctl $*" >> "$CALLS"')
        self.script(self.bin / 'reboot', '[ "$#" = 1 ] && [ "$1" = "0 tryboot" ]; echo "reboot argc=$# arg=$1" >> "$CALLS"')
        self.script(self.bin / 'sync', ':')

    def script(self, path, body):
        path.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n')
        path.chmod(0o755)

    def run_guard(self, mode='success', platform='x86'):
        self.env['MODE'] = mode
        return subprocess.run(['bash', str(self.root / 'guard.sh'), platform, 'rootfs.1', 's ":1.42"'],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def test_x86_waits_for_completion_and_activation(self):
        result = self.run_guard()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().splitlines(), ['migrate', 'systemctl reboot'])
        self.assertGreaterEqual(int((self.root / 'count').read_text()), 3)
        self.assertIn('reboot requested', self.status.read_text())
        self.assertTrue((self.root / 'ready').exists())

    def test_missing_readiness_acknowledgement_never_reboots(self):
        result = self.run_guard('notify_failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())
        self.assertFalse((self.root / 'ready').exists())
        self.assertIn('Reboot guard failed', self.status.read_text())

    def test_invalid_platform_leaves_diagnostics_before_exiting(self):
        result = self.run_guard(platform='invalid')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid reboot platform or target slot', self.status.read_text())
        self.assertFalse((self.root / 'ready').exists())
        self.assertFalse(self.log.exists())

    def test_pi_requests_tryboot_only_after_activation(self):
        result = self.run_guard(platform='pi')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('reboot argc=1 arg=0 tryboot', self.log.read_text())

    def test_staged_scripts_need_read_access_not_execute_permission(self):
        # Reproduce the executable-access restriction without a privileged
        # noexec mount. Both scripts must be interpreted by the host's bash;
        # executing the staged state helper directly would fail with EACCES.
        (self.root / 'guard.sh').chmod(0o600)
        (self.root / 'state.sh').chmod(0o600)
        for platform in ('pi', 'x86'):
            with self.subTest(platform=platform):
                self.log.unlink(missing_ok=True)
                result = self.run_guard(platform=platform)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.log.read_text().splitlines()[0], 'migrate')
                self.assertIn('reboot requested', self.status.read_text())

    def test_pi_without_pending_slot_does_not_reboot(self):
        (self.root / 'slot-state').write_text('pending=A\n')
        self.assertNotEqual(self.run_guard(platform='pi').returncode, 0)
        self.assertFalse(self.log.exists())

    def test_transaction_failure_does_not_reboot(self):
        self.assertNotEqual(self.run_guard('failed').returncode, 0)
        self.assertFalse(self.log.exists())
        self.assertIn('installation failed', self.status.read_text())

    def test_daemon_restart_does_not_reboot(self):
        self.assertNotEqual(self.run_guard('restart').returncode, 0)
        self.assertFalse(self.log.exists())

    def test_unactivated_target_does_not_reboot(self):
        self.assertNotEqual(self.run_guard('wrongslot').returncode, 0)
        self.assertFalse(self.log.exists())

    def test_busy_install_times_out_without_reboot(self):
        self.env['BF_REBOOT_WAIT_SECONDS'] = '1'
        self.assertNotEqual(self.run_guard('timeout').returncode, 0)
        self.assertFalse(self.log.exists())
        self.assertIn('deadline', self.status.read_text())


class MigrationTests(unittest.TestCase):
    def test_migration_is_once_but_old_system_activation_refreshes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy, shared = root / 'legacy', root / 'shared'
            legacy.mkdir()
            (legacy / 'slot-state').write_text('pending=A')
            env = dict(os.environ, BF_RAUC_LEGACY_DIR=str(legacy), BF_RAUC_SHARED_DIR=str(shared))
            command = ['bash', str(DEPLOY / 'systemd/betterframe-rauc-state.sh')]
            subprocess.run(command, env=env, check=True)
            (legacy / 'slot-state').write_text('pending=B')
            subprocess.run(command, env=env, check=True)
            self.assertEqual((shared / 'slot-state').read_text(), 'pending=A')
            subprocess.run(command + ['--refresh-legacy'], env=env, check=True)
            self.assertEqual((shared / 'slot-state').read_text(), 'pending=B')


class ConfirmationTests(unittest.TestCase):
    def test_late_pairing_health_can_confirm_on_service_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker, confirmed = root / 'healthy', root / 'confirmed'
            rauc = root / 'rauc'
            rauc.write_text('#!/bin/sh\n[ "$*" = "status mark-good" ]\n')
            rauc.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                       BF_RAUC_HEALTH_MARKER=str(marker), BF_RAUC_CONFIRMED_MARKER=str(confirmed),
                       BF_RAUC_MARK_GOOD_TIMEOUT='0')
            command = ['bash', str(DEPLOY / 'systemd/betterframe-rauc-mark-good.sh')]
            self.assertNotEqual(subprocess.run(command, env=env, capture_output=True).returncode, 0)
            self.assertFalse(confirmed.exists())
            marker.write_text('healthy')
            env['BF_RAUC_MARK_GOOD_TIMEOUT'] = '1'
            subprocess.run(command, env=env, check=True)
            self.assertTrue(confirmed.exists())
            service = (DEPLOY / 'systemd/betterframe-rauc-mark-good.service').read_text()
            self.assertIn('Restart=on-failure', service)
            self.assertIn('RestartSec=10s', service)

    def test_failed_mark_good_never_claims_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'healthy').write_text('healthy')
            rauc = root / 'rauc'
            rauc.write_text('#!/bin/sh\nexit 1\n')
            rauc.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                       BF_RAUC_HEALTH_MARKER=str(root / 'healthy'),
                       BF_RAUC_CONFIRMED_MARKER=str(root / 'confirmed'), BF_RAUC_MARK_GOOD_TIMEOUT='1')
            result = subprocess.run(['bash', str(DEPLOY / 'systemd/betterframe-rauc-mark-good.sh')], env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'confirmed').exists())


if __name__ == '__main__':
    unittest.main()
