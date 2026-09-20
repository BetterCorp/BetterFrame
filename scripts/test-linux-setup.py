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

    def test_os_release_does_not_overwrite_app_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp) / 'os-release'
            release.write_text('ID=ubuntu\nID_LIKE=debian\nVERSION="26.04.1 LTS (Resolute Raccoon)"\n')
            for version in ['', 'latest', '1.0.14-dev.gf0075a9']:
                result = self.shell(f'VERSION={shlex.quote(version)}; load_distribution {shlex.quote(str(release))}; '
                                    'printf "%s\\n%s\\n%s\\n" "$VERSION" "$DISTRO_ID" "$DISTRO_LIKE"')
                self.assertEqual(result.stdout.splitlines(), [version, 'ubuntu', 'debian'])

    def test_distribution_and_runtime_baseline(self):
        for distro, version, supported in [('ubuntu','22.04',False), ('ubuntu','24.04',True),
                                           ('ubuntu','26.04',True), ('debian','12',False), ('debian','13',True)]:
            result = self.shell(f'DISTRO_ID={distro}; DISTRO_VERSION={version}; validate_distribution', check=False)
            self.assertEqual(result.returncode == 0, supported)
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'ctypes.py'
            for minor, webkit, supported in [(8, True, False), (14, False, False), (14, True, True), (18, True, True)]:
                p.write_text(f'''class Library:
    def gtk_get_major_version(self): return 4
    def gtk_get_minor_version(self): return {minor}
def CDLL(name):
    if name.startswith('libwebkit') and not {webkit!r}: raise OSError('missing WebKitGTK')
    return Library()
''')
                result = self.shell(f'export PYTHONPATH={tmp}; check_runtime_libraries', check=False)
                self.assertEqual(result.returncode == 0, supported, result.stderr)

    def test_alternate_failed_scope_does_not_replace_healthy_rollback_choice(self):
        for mode, selected, alternate in [('desktop', 'user', 'system'), ('dedicated', 'system', 'user')]:
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp)
                (p / 'app').write_text('working current app')
                (p / 'app.prev').write_text('older rollback')
                (p / 'candidate').write_text('new candidate')
                result = self.shell(f'''
                    MODE={mode}; BIN={p}/app; STATE={p}; STAGING={p}; INSTALL_USER={os.getuid()}; USER_GROUP={os.getgid()}
                    service_command() {{
                        case "$2" in
                            show) if [[ $* == *LoadState* ]]; then echo loaded; else echo inactive; fi;;
                            is-active) [[ $1 == {selected} ]];;
                            is-failed) [[ $1 == {alternate} ]];;
                            *) return 0;;
                        esac
                    }}
                    stop_app_service {selected} app.service
                    stop_app_service {alternate} stale.service
                    install_app_binary
                ''')
                self.assertEqual((p / 'app.prev').read_text(), 'working current app')

    def test_deferred_candidate_gets_first_start_before_age_deadline(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'app').write_text('working current app')
            (p / 'candidate').write_text('new untested candidate')
            # An inactive app without a pending/failed candidate is still the rollback.
            self.shell(f'''BIN={p}/app; STATE={p}; STAGING={p}; INSTALL_USER={os.getuid()}; USER_GROUP={os.getgid()}; BACKUP_ID=test
                install_app_binary
                clear_interrupted_update
                arm_setup_candidate
            ''')
            marker = p / 'firmware-applying.json'
            payload = json.loads(marker.read_text())
            self.assertEqual(payload['sha256'], hashlib.sha256((p / 'app').read_bytes()).hexdigest())
            self.assertEqual((p / 'app.prev').read_text(), 'working current app')
            os.utime(marker, (1, 1)) # Candidate installed long before the next login.
            script = (ROOT / 'deploy/systemd/betterframe-firmware-rollback.sh').read_text()
            script = script.replace('/opt/betterframe/kiosk/betterframe-kiosk', str(p/'app')).replace('/var/lib/betterframe/kiosk', str(p))
            (p / 'rollback.sh').write_text(script)
            subprocess.run(['bash', str(p/'rollback.sh')], check=True, capture_output=True)
            self.assertEqual((p/'app').read_text(), 'new untested candidate')
            self.assertEqual((p/'firmware-applying.attempts').read_text().strip(), '1')
            # An old marker after a real start does still roll back.
            os.utime(marker, (1, 1))
            subprocess.run(['bash', str(p/'rollback.sh')], check=True, capture_output=True)
            self.assertEqual((p/'app').read_text(), 'working current app')
            self.assertFalse(marker.exists())

    def test_alpha_releases_are_dev_for_discovery_and_saved_inference(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            version = '2.0.0-alpha.2'
            artifact = f'betterframe-kiosk-{version}-betterframe-pc-x86_64'
            (p/'releases.json').write_text(json.dumps([{'tag_name':'v'+version, 'published_at':'2026-09-20',
                'assets':[{'name':artifact+suffix} for suffix in ['', '.sha256', '.sig']]}]))
            self.assertEqual(self.shell(f'CHANNEL=dev; TARGET=betterframe-pc-x86_64; select_channel_release {p}/releases.json').stdout.strip(), 'v'+version)
            self.assertEqual(self.shell(f'CHANNEL=beta; TARGET=betterframe-pc-x86_64; select_channel_release {p}/releases.json').stdout.strip(), '')
            self.assertEqual(self.shell(f'CONFIG={p}/config; parse_args --version {version}; load_settings; echo "$CHANNEL"').stdout.strip(), 'dev')

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
        for command in ['write_desktop_unit', 'INSTALL_USER=kiosk; USER_ID=1000; write_dedicated_unit',
                        'write_repair_override']:
            unit = self.shell(command).stdout
            self.assertIn('Restart=always', unit)
            self.assertIn('StartLimitIntervalSec=0', unit)
            self.assertIn('BF_ENABLE_OS_OTA=0', unit)
            self.assertIn('/opt/betterframe/kiosk/betterframe-kiosk', unit)
            self.assertNotIn('reboot', unit)
        updater = (ROOT / 'client/src/platform/linux/firmware.rs').read_text()
        self.assertNotIn('.arg("reboot")', updater)
        self.assertNotIn('Command::new', updater)
        self.assertIn('on_progress("Restarting app", 100)', updater)
        unit = (ROOT / 'deploy/systemd/betterframe-kiosk.service').read_text()
        self.assertNotIn('Action=reboot', unit)
        self.assertIn('StartLimitIntervalSec=0', unit)
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

    def test_saved_choices_survive_root_reruns_and_legacy_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'install'
            config.write_text('kiosk dedicated dev\n')
            cmd = f'CONFIG={config}; INSTALL_USER=; load_settings; echo "$INSTALL_USER $MODE $CHANNEL $PREVIOUS_INSTALL"'
            self.assertEqual(self.shell(cmd).stdout.strip(), 'kiosk dedicated dev 1')
            config.write_text('kiosk dedicated\n')
            self.assertEqual(self.shell(cmd).stdout.strip(), 'kiosk dedicated stable 1')
            self.assertNotEqual(self.shell(f'CONFIG={config}; parse_args --user someone; load_settings', check=False).returncode, 0)
            self.assertEqual(self.shell(f'CONFIG={config}; parse_args --channel beta; load_settings; echo "$CHANNEL"').stdout.strip(), 'beta')
            self.assertEqual(self.shell(f'CONFIG={config}; parse_args --version 1.2.3-dev.gabcd; load_settings; echo "$CHANNEL"').stdout.strip(), 'dev')

    def test_managed_configuration_converges_and_only_backs_up_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'unit'
            path.write_text('drifted')
            cmd = f'BACKUP_ID=first; printf canonical | reconcile_file {path} 600 {os.getuid()} {os.getgid()}'
            self.shell(cmd)
            self.assertEqual(path.read_text(), 'canonical')
            self.assertEqual((Path(tmp) / 'unit.before-setup.first').read_text(), 'drifted')
            path.chmod(0o777)
            self.shell(cmd.replace('first', 'second'))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse((Path(tmp) / 'unit.before-setup.second').exists())
            # A persistent systemd mask must be replaced, not followed.
            path.unlink()
            path.symlink_to('/dev/null')
            self.shell(cmd.replace('first', 'mask'))
            self.assertFalse(path.is_symlink())
            self.assertEqual(path.read_text(), 'canonical')

    def test_pending_candidate_does_not_overwrite_good_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'app').write_text('broken pending candidate')
            (p / 'app.prev').write_text('known previous app')
            (p / 'candidate').write_text('new repair app')
            (p / 'firmware-applying.json').write_text('{}')
            (p / 'identity.json').write_text('pairing identity')
            (p / 'app.new').symlink_to(p / 'identity.json')
            cmd = f'BIN={p}/app; STATE={p}; STAGING={p}; INSTALL_USER={os.getuid()}; USER_GROUP={os.getgid()}; install_app_binary'
            self.shell(cmd)
            self.assertEqual((p / 'app.prev').read_text(), 'known previous app')
            self.assertEqual((p / 'app').read_text(), 'new repair app')
            self.assertEqual((p / 'identity.json').read_text(), 'pairing identity')
            # A service already failed without a pending marker also retains rollback.
            (p / 'firmware-applying.json').unlink()
            (p / 'candidate').write_text('another repair app')
            self.shell('PRESERVE_PREVIOUS=1; ' + cmd)
            self.assertEqual((p / 'app.prev').read_text(), 'known previous app')

    def test_recovery_clears_only_app_update_state(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            for name in ['identity.json', 'bundle.json', 'kiosk.key', 'os-applying.json']:
                (p / name).write_text('preserve me')
            for name in ['firmware-applying.json', 'firmware-applying.attempts', 'app.new']:
                (p / name).write_text('stale')
            history = {'entries': {'firmware:1.2.3': {'failures': 9}, 'os:1.2.3': {'failures': 2}}}
            (p / 'update-attempts.json').write_text(json.dumps(history))
            cmd = f'STATE={p}; BIN={p}/app; INSTALL_USER={os.getuid()}; BACKUP_ID=repair; clear_interrupted_update'
            self.shell(cmd)
            for name in ['identity.json', 'bundle.json', 'kiosk.key', 'os-applying.json']:
                self.assertEqual((p / name).read_text(), 'preserve me')
            self.assertEqual(json.loads((p / 'update-attempts.json').read_text()), {'entries': {'os:1.2.3': {'failures': 2}}})
            for name in ['firmware-applying.json', 'firmware-applying.attempts', 'app.new']:
                self.assertFalse((p / name).exists())
            self.shell(cmd.replace('BACKUP_ID=repair', 'BACKUP_ID=again'))
            self.assertFalse(list(p.glob('*.before-setup.again')))

    def test_stuck_stop_escalates_before_install_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            cmd = f'''service_command() {{
                echo "$*" >> {tmp}/calls
                case "$2" in
                  show) if [[ $* == *LoadState* ]]; then echo loaded; else echo inactive; fi;;
                  is-failed) return 0;;
                  stop) [[ -e {tmp}/killed ]];;
                  kill) touch {tmp}/killed;;
                esac
            }}
            stop_app_service user betterframe.service
            echo "$PRESERVE_PREVIOUS"'''
            self.assertEqual(self.shell(cmd).stdout.strip(), '1')
            calls = (Path(tmp) / 'calls').read_text()
            self.assertIn('kill --kill-whom=all --signal=KILL', calls)
            self.assertEqual(calls.count('stop betterframe.service'), 2)
            bad = self.shell('service_command() { case "$2" in show) echo active;; is-failed) return 1;; *) return 0;; esac; }; stop_app_service user betterframe.service', check=False)
            self.assertNotEqual(bad.returncode, 0)

    def test_failed_start_restores_previous_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'app').write_text('broken')
            (p / 'app.prev').write_text('previous')
            cmd = f'''BIN={p}/app; STATE={p}; INSTALL_USER={os.getuid()}; USER_GROUP={os.getgid()}
            sleep() {{ :; }}
            service_command() {{
                echo "$*" >> {p}/calls
                case "$2" in
                    show) if [[ $* == *LoadState* ]]; then echo loaded; else echo inactive; fi;;
                    is-active) return 1;;
                    *) return 0;;
                esac
            }}
            start_app_service user betterframe.service'''
            result = self.shell(cmd, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((p / 'app').read_text(), 'previous')
            calls = (p / 'calls').read_text().splitlines()
            self.assertEqual(calls[:2], ['user is-failed --quiet betterframe.service', 'user reset-failed betterframe.service'])
            self.assertEqual(calls[-1], 'user start betterframe.service')

    def test_channel_selection_excludes_drafts_and_incomplete_or_other_target_assets(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'releases.json'
            def release(version, published, target='betterframe-pc-x86_64'):
                name = f'betterframe-kiosk-{version}-{target}'
                return {'tag_name': f'v{version}', 'published_at': published, 'assets': [{'name': name+s} for s in ['', '.sig', '.sha256']]}
            releases = [release('1.2.3-dev.g1', '2026-09-01'), release('1.2.4-dev.g2', '2026-09-02'),
                        release('1.2.5-beta.1', '2026-09-03'), release('1.2.6-dev.g3', '2026-09-04')]
            releases[-1]['assets'].pop()
            releases.append(release('1.2.7-dev.g4', '2026-09-05', 'betterframe-rpi5-aarch64'))
            releases.append(dict(release('1.2.8-dev.g5', '2026-09-06'), draft=True))
            p.write_text(json.dumps(releases))
            cmd = f'CHANNEL=dev; TARGET=betterframe-pc-x86_64; select_channel_release {p}'
            self.assertEqual(self.shell(cmd).stdout.strip(), 'v1.2.4-dev.g2')


    def test_normal_repair_downloads_even_with_a_broken_existing_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'app').write_text('broken installed executable')
            cmd = f'''BIN={p}/app; STAGING={p}; TARGET=betterframe-pc-x86_64
            download_release() {{ cp /bin/true {p}/download; SOURCE_BINARY={p}/download; }}
            prepare_candidate'''
            self.shell(cmd)
            self.assertEqual((p / 'candidate').read_bytes(), Path('/bin/true').read_bytes())
            self.assertEqual((p / 'app').read_text(), 'broken installed executable')

    def test_download_failure_leaves_current_app_and_recovery_state_intact(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'app').write_text('current app')
            (p / 'firmware-applying.json').write_text('pending')
            result = self.shell(f'BIN={p}/app; STATE={p}; STAGING={p}; download_release() {{ return 1; }}; prepare_candidate', check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((p / 'app').read_text(), 'current app')
            self.assertEqual((p / 'firmware-applying.json').read_text(), 'pending')
            self.assertFalse((p / 'candidate').exists())

    def test_fresh_service_starts_without_resetting_unloaded_unit(self):
        self.shell('''
            sleep() { :; }
            service_command() {
                case "$2" in
                    is-failed) return 1;;
                    reset-failed) echo "Unit not loaded" >&2; return 1;;
                    show) echo 1234;;
                    *) return 0;;
                esac
            }
            start_app_service user betterframe.service
        ''')
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            launcher = p / 'launcher'
            launcher.write_text(self.shell('write_launcher').stdout)
            systemctl = p / 'systemctl'
            systemctl.write_text('#!/bin/bash\ncase "$2" in\n'
                                 'is-failed) exit 1;;\n'
                                 'reset-failed) exit 1;;\n'
                                 'restart) echo started;;\nesac\n')
            systemctl.chmod(0o755)
            env = dict(os.environ, PATH=f'{p}:{os.environ["PATH"]}')
            result = subprocess.run(['bash', str(launcher)], env=env, text=True,
                                    capture_output=True, check=True)
            self.assertIn('started', result.stdout)

    def test_reset_failure_does_not_block_real_startup(self):
        self.shell('''
            sleep() { :; }
            service_command() {
                case "$2" in
                    reset-failed) return 1;;
                    show) echo 1234;;
                    *) return 0;;
                esac
            }
            start_app_service user betterframe.service
        ''')

    def test_start_success_requires_a_stable_process_after_reset(self):
        self.shell('''
            sleep() { :; }
            service_command() {
                case "$2" in
                    show) echo 1234;;
                    *) return 0;;
                esac
            }
            start_app_service system betterframe-kiosk.service
        ''')


    @unittest.skipUnless(os.geteuid() == 0 and shutil.which('runuser'), 'requires root in a disposable container')
    def test_root_installer_writes_runtime_files_without_root_privileges(self):
        account = pwd.getpwnam('nobody')
        group = grp.getgrgid(account.pw_gid).gr_name
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            p.chmod(0o755)
            private = p / 'root-private'
            private.mkdir(mode=0o700)
            protected = private / 'protected'
            protected.write_text('must not change')
            runtime = p / 'runtime'
            runtime.mkdir()
            os.chown(runtime, account.pw_uid, account.pw_gid)
            unit = runtime / 'betterframe.service'
            unit.symlink_to(protected)
            cmd = f'BACKUP_ID=test; printf canonical | reconcile_file {unit} 644 nobody {group}'
            self.shell(cmd)
            self.assertEqual(protected.read_text(), 'must not change')
            self.assertEqual(unit.read_text(), 'canonical')
            self.assertEqual(unit.stat().st_uid, account.pw_uid)
            # A redirected parent must also fail without writing a root file.
            (runtime / 'redirect').symlink_to(private, target_is_directory=True)
            self.assertNotEqual(self.shell(cmd.replace(str(unit), str(runtime / 'redirect/protected')), check=False).returncode, 0)
            self.assertEqual(protected.read_text(), 'must not change')
            (runtime / 'app').write_text('old app')
            (runtime / 'app.prev').symlink_to(protected)
            (runtime / 'app.new').symlink_to(protected)
            (p / 'candidate').write_text('verified replacement')
            self.shell(f'INSTALL_USER=nobody; USER_GROUP={group}; BIN={runtime}/app; STATE={runtime}; STAGING={p}; PRESERVE_PREVIOUS=0; install_app_binary')
            self.assertEqual(protected.read_text(), 'must not change')
            self.assertEqual((runtime / 'app').read_text(), 'verified replacement')
            self.assertEqual((runtime / 'app.prev').read_text(), 'old app')


    def one_line_install(self):
        import re
        readme = (ROOT / 'README.md').read_text().split('## Install the Linux app', 1)[1]
        command = re.search(r'```sh\n([^\n]+)\n```', readme).group(1)
        self.assertIn(command, (ROOT / 'docs/linux-install.md').read_text())
        return command

    def test_one_line_bootstraps_apt_and_dnf_without_existing_curl(self):
        for manager in ['apt-get', 'dnf']:
            with self.subTest(manager=manager), tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp)
                tools = p / 'bin'
                tools.mkdir()
                for tool in ['bash', 'mktemp', 'rm']:
                    (tools / tool).symlink_to(shutil.which(tool))
                scripts = {
                    'sudo': '#!/bin/bash\nexec "$@"\n',
                    manager: '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_PACKAGES"\nif [[ $1 == install ]]; then /bin/cp "$TEST_CURL_STUB" "$TEST_BIN/curl"; /bin/chmod 755 "$TEST_BIN/curl"; fi\n',
                }
                for name, content in scripts.items():
                    (tools / name).write_text(content)
                    (tools / name).chmod(0o755)
                curl = p / 'curl-stub'
                curl.write_text('''#!/bin/bash
set -eu
while (($#)); do
    if [[ $1 == -o ]]; then output=$2; shift; fi
    shift
done
printf '%s' "$output" > "$TEST_DOWNLOAD_PATH"
/bin/cat "$TEST_PAYLOAD" > "$output"
''')
                payload = p / 'payload'
                payload.write_text('''#!/bin/bash
printf '%s\\n' "$@" > "$TEST_ARGS"
read -r answer
printf '%s' "$answer" > "$TEST_INPUT"
''')
                env = dict(os.environ, PATH=str(tools), TEST_BIN=str(tools), TEST_CURL_STUB=str(curl),
                           TEST_PACKAGES=str(p/'packages'), TEST_DOWNLOAD_PATH=str(p/'download'),
                           TEST_PAYLOAD=str(payload), TEST_ARGS=str(p/'args'), TEST_INPUT=str(p/'input'))
                command = self.one_line_install()
                subprocess.run([str(tools/'bash'), '-c', command+' --yes --channel dev'], env=env,
                               input='desktop-choice\n', text=True, capture_output=True, check=True)
                self.assertIn('install -y ca-certificates curl util-linux', (p/'packages').read_text())
                self.assertEqual((p/'args').read_text().splitlines(), ['--yes', '--channel', 'dev'])
                self.assertEqual((p/'input').read_text(), 'desktop-choice')
                self.assertFalse(Path((p/'download').read_text()).exists())
                # A truncated/error response must never be executed, and is cleaned up.
                (p/'args').unlink()
                curl.write_text(curl.read_text()+'exit 22\n')
                result = subprocess.run([str(tools/'bash'), '-c', command], env=env, input='',
                                        text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((p/'args').exists())
                self.assertFalse(Path((p/'download').read_text()).exists())

    def test_downloaded_setup_needs_no_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 'setup.sh'
            shutil.copy(ROOT/'setup.sh', script)
            result = subprocess.run(['bash', '-c', f'source {shlex.quote(str(script))}; write_rollback_helper'],
                                    text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout, (ROOT/'deploy/systemd/betterframe-firmware-rollback.sh').read_text())
            subprocess.run(['bash', '-n'], input=result.stdout, text=True, check=True)
            help_result = subprocess.run(['bash', str(script), '--help'], text=True, capture_output=True, check=True)
            self.assertIn('Install, update, or repair', help_result.stdout)


    def test_media_gateway_choice_is_remembered_and_can_be_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp)/'install'
            config.write_text('kiosk desktop dev off\n')
            cmd = f'CONFIG={config}; load_settings; echo "$MEDIA_GATEWAY $MEDIA_SAVED"'
            self.assertEqual(self.shell(cmd).stdout.strip(), 'off 1')
            self.assertEqual(self.shell(f'CONFIG={config}; parse_args --media-gateway on; load_settings; echo "$MEDIA_GATEWAY"').stdout.strip(), 'on')
            config.write_text('kiosk desktop dev\n')
            self.assertEqual(self.shell(cmd).stdout.strip(), 'on 0')
            self.assertNotEqual(self.shell(f'CONFIG={config}; parse_args --media-gateway invalid; load_settings', check=False).returncode, 0)

    def test_mediamtx_bundle_matches_managed_images(self):
        self.assertEqual(self.shell('echo "$MEDIAMTX_VERSION"').stdout.strip(), (ROOT/'deploy/mediamtx.version').read_text().strip())
        self.assertEqual(self.shell('write_mediamtx_config').stdout, (ROOT/'deploy/mediamtx.yml').read_text())
        unit = self.shell('INSTALL_USER=kiosk; USER_GROUP=kiosk; write_mediamtx_unit').stdout
        self.assertIn('User=kiosk', unit)
        self.assertIn('Restart=always', unit)
        self.assertIn('ReadWritePaths=/var/lib/betterframe/recordings', unit)

    def test_mediamtx_archive_integrity_and_member_safety(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            archive = p/'gateway.tar.gz'
            def make_archive(symlink=False):
                with tarfile.open(archive, 'w:gz') as bundle:
                    member = tarfile.TarInfo('mediamtx')
                    if symlink:
                        member.type = tarfile.SYMTYPE
                        member.linkname = '/etc/passwd'
                        bundle.addfile(member)
                    else:
                        data = b'gateway executable'
                        member.size = len(data)
                        bundle.addfile(member, io.BytesIO(data))
                (p/'mediamtx-checksums').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  gateway.tar.gz\n')
            cmd = f'STAGING={p}; MEDIAMTX_ARCHIVE=gateway.tar.gz; verify_mediamtx_archive'
            make_archive()
            self.shell(cmd)
            self.assertEqual((p/'mediamtx').read_bytes(), b'gateway executable')
            archive.write_bytes(b'corrupted')
            self.assertNotEqual(self.shell(cmd, check=False).returncode, 0)
            (p/'mediamtx').unlink()
            make_archive(symlink=True)
            self.assertNotEqual(self.shell(cmd, check=False).returncode, 0)
            self.assertFalse((p/'mediamtx').exists())


if __name__ == '__main__':
    unittest.main()
