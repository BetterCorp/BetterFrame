"""Real ext4 image sizing tests; no mounts, block devices or root required."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

RAUC = Path(__file__).resolve().parents[1]
ENV = dict(os.environ, PATH=os.environ['PATH'] + ':/usr/sbin:/sbin')


class CompactRootfsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.image = self.root / 'rootfs.ext4'

    def run_command(self, *args, check=True):
        return subprocess.run(args, env=ENV, capture_output=True, text=True, check=check)

    def compact(self, limit=0):
        return self.run_command('bash', str(RAUC / 'compact-rootfs.sh'),
                                str(self.image), str(limit), check=False)

    def test_payload_fits_older_slot_and_keeps_files_after_expansion(self):
        # Exact reported regression: new 5679 MiB image, old 5678 MiB slot.
        with self.image.open('wb') as image:
            image.truncate(5954863104)
        self.run_command('mkfs.ext4', '-q', '-F', str(self.image))
        marker = self.root / 'marker'
        marker.write_text('BetterFrame update data survives shrink and grow\n')
        self.run_command('debugfs', '-w', '-R', f'write {marker} /marker', str(self.image))
        result = self.compact(5953814528)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(self.image.stat().st_size, 5953814528)
        # Simulate copying the compact payload into the existing larger slot.
        with self.image.open('r+b') as image:
            image.truncate(5953814528)
        self.run_command('resize2fs', str(self.image))
        result = self.run_command('e2fsck', '-fn', str(self.image), check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_command('debugfs', '-R', 'cat /marker', str(self.image))
        self.assertEqual(result.stdout, marker.read_text())

    def test_corrupt_input_is_rejected(self):
        self.image.write_bytes(b'not an ext4 filesystem')
        self.assertNotEqual(self.compact().returncode, 0)

    def test_payload_exceeding_compatibility_limit_is_rejected(self):
        with self.image.open('wb') as image:
            image.truncate(96 * 1024 * 1024)
        self.run_command('mkfs.ext4', '-q', '-F', str(self.image))
        result = self.compact(1024 * 1024)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exceeds supported slot', result.stderr)


class ResizeHookTests(unittest.TestCase):
    def test_resize_failure_stops_before_configuration_and_reboot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mnt = root / 'mounted'
            (mnt / 'etc').mkdir(parents=True)
            fstab = mnt / 'etc/fstab'
            fstab.write_text('unchanged\n')
            log = root / 'calls'
            for name, body in {
                'resize2fs': 'echo "resize $*" >> "$CALLS"; exit 1',
                'sync': ':',
                'blkid': 'echo forbidden >> "$CALLS"; exit 1',
                'systemd-run': 'echo forbidden >> "$CALLS"; exit 1',
            }.items():
                script = root / name
                script.write_text('#!/bin/sh\n' + body + '\n')
                script.chmod(0o755)
            env = dict(ENV, PATH=f'{root}:{ENV["PATH"]}', CALLS=str(log),
                       RAUC_SLOT_NAME='rootfs.1', RAUC_SLOT_CLASS='rootfs',
                       RAUC_SLOT_DEVICE='/dev/mock-inactive-slot',
                       RAUC_SLOT_MOUNT_POINT=str(mnt))
            result = subprocess.run(['bash', str(RAUC / 'hook.sh'), 'slot-post-install'],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(log.read_text(), 'resize /dev/mock-inactive-slot\n')
            self.assertEqual(fstab.read_text(), 'unchanged\n')


if __name__ == '__main__':
    unittest.main()
