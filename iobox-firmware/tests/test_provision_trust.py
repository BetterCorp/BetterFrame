import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('provision', Path(__file__).parents[1] / 'scripts/provision_trust.py')
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class TrustProvisioningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(root / 'ca.key'), '-out', str(root / 'ca.pem'),
                        '-subj', '/CN=ioBOX test CA', '-days', '1'], check=True, capture_output=True)
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(root / 'sign.key')], check=True, capture_output=True)
        cls.public = subprocess.run(['openssl', 'pkey', '-in', str(root / 'sign.key'), '-pubout'], check=True, capture_output=True).stdout.decode()
        cls.ca = (root / 'ca.pem').read_text()
        cls.private = (root / 'sign.key').read_text()
        cls.rsa_public = subprocess.run(['openssl', 'pkey', '-in', str(root / 'ca.key'), '-pubout'], check=True, capture_output=True).stdout.decode()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_preserves_ca_and_extracts_real_ed25519_key(self):
        header = provision.trust_header(self.ca, self.public)
        der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=self.public.encode(), check=True, capture_output=True).stdout
        self.assertIn(der[-32:].hex(), header)
        self.assertIn('BEGIN CERTIFICATE', header)
        self.assertNotIn('PRIVATE KEY', header)

    def test_rejects_private_key_input(self):
        with self.assertRaises(ValueError):
            provision.trust_header(self.ca, self.private)

    def test_rejects_other_signing_algorithms(self):
        with self.assertRaises(ValueError):
            provision.trust_header(self.ca, self.rsa_public)

    def test_rejects_invalid_certificate(self):
        with self.assertRaises(subprocess.CalledProcessError):
            provision.trust_header('not a certificate', self.public)


if __name__ == '__main__':
    unittest.main()
