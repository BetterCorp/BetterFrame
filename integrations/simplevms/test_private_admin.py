import importlib.util
from pathlib import Path
import unittest
import os
import tempfile

spec = importlib.util.spec_from_file_location("private_pairing", Path(__file__).with_name("configure-controlroom-pairing.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateAdminTests(unittest.TestCase):
    def setUp(self):
        self.origin = "https://recorder.test:8080"
        self.token = "x" * 43
        self.site = '''https://other.test {
    respond "other"
}
https://recorder.test:8080 {
    @outsidePrivateNetworks not remote_ip 10.0.0.0/8 100.64.0.0/10
    route {
        respond @outsidePrivateNetworks "Private service" 403
        handle {
            respond "native"
        }
    }
}
'''

    def test_only_the_existing_private_native_site_gets_pairing_proof(self):
        result = module.render_caddy(self.site, self.origin, self.token)
        self.assertTrue(result.startswith('https://other.test {\n    respond "other"\n}\n'))
        self.assertLess(result.index(module.BOUNDARY), result.index(module.BEGIN))
        self.assertIn('/pairing/begin /api/v1/plugins/bettercorp-betterframe/pairing/complete', result)
        self.assertIn('not header Origin "https://recorder.test:8080"', result)
        self.assertIn('header_up X-BetterFrame-Pairing-Admin "' + self.token + '"', result)
        self.assertEqual(result.count(self.token), 1)
        self.assertEqual(module.render_caddy(result, self.origin, self.token), result)

    def test_public_or_unknown_sites_and_invalid_configuration_are_rejected(self):
        for origin in ('http://recorder.test:8080', 'https://u:p@recorder.test:8080', self.origin + '/path', self.origin + '?x=1', 'https://unknown.test'):
            with self.assertRaises(module.ConfigurationError):
                module.render_caddy(self.site, origin, self.token)
        with self.assertRaises(module.ConfigurationError):
            module.render_caddy(self.site.replace(module.BOUNDARY, ''), self.origin, self.token)
        with self.assertRaises(module.ConfigurationError):
            module.render_caddy(self.site, self.origin, 'short')

    def test_private_writes_are_atomic_restricted_and_do_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'proxy-admin.json'
            module.write_private(path, b'first', os.getuid(), os.getgid())
            module.write_private(path, b'second', os.getuid(), os.getgid())
            self.assertEqual(path.read_bytes(), b'second')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            link = Path(directory) / 'link'
            link.symlink_to(path)
            with self.assertRaises(module.ConfigurationError):
                module.write_private(link, b'wrong', os.getuid(), os.getgid())
            self.assertEqual(path.read_bytes(), b'second')


if __name__ == '__main__':
    unittest.main()
