#!/usr/bin/env python3
"""Exercises the actual Linux reconciler in isolated directories, never system trust."""
import hashlib
import importlib.util
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("trust", ROOT / "deploy/systemd/betterframe-trusted-cas.py")
trust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trust)

class TrustedCaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.cadir = self.root / "certs"
        self.calls = 0
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=BF Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", str(self.root / "key"), "-out", str(self.root / "ca")], check=True, capture_output=True)
        pem = (self.root / "ca").read_text()
        self.ca = {"pem": pem, "fingerprint_sha256": hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()}
    def update(self):
        self.calls += 1
    def apply(self, cas):
        return trust.reconcile(cas, self.state, self.cadir, self.update)
    def test_installs_idempotently_removes_owned_and_preserves_unrelated_roots(self):
        self.cadir.mkdir()
        external = self.cadir / "external.crt"
        external.write_text("external administrator certificate")
        self.assertTrue(self.apply([self.ca]))
        installed = self.cadir / ("betterframe-" + self.ca["fingerprint_sha256"] + ".crt")
        self.assertEqual(installed.read_text(), self.ca["pem"])
        self.assertFalse(self.apply([self.ca]))
        self.assertEqual(self.calls, 1)
        self.assertTrue(self.apply([]))
        self.assertFalse(installed.exists())
        self.assertTrue(external.exists())
        self.assertFalse(self.apply([]))
    def test_never_claims_or_deletes_an_existing_certificate(self):
        self.cadir.mkdir()
        target = self.cadir / ("betterframe-" + self.ca["fingerprint_sha256"] + ".crt")
        target.write_text(self.ca["pem"])
        self.apply([self.ca]); self.apply([])
        self.assertTrue(target.exists())
    def test_rejects_entire_set_before_mutating_on_bad_signature_key_fingerprint_or_leaf(self):
        self.apply([self.ca])
        before = (self.state / "ownership.json").read_bytes()
        forged = bytearray(ssl.PEM_cert_to_DER_cert(self.ca["pem"])); forged[-1] ^= 1
        cases = [
            {**self.ca, "fingerprint_sha256": "../path"},
            {**self.ca, "fingerprint_sha256": "0" * 64},
            {**self.ca, "pem": self.ca["pem"] + (self.root / "key").read_text()},
            {"pem": ssl.DER_cert_to_PEM_cert(forged), "fingerprint_sha256": hashlib.sha256(forged).hexdigest()},
        ]
        leaf = self.root / "non-ca.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Leaf", "-addext", "basicConstraints=critical,CA:FALSE", "-keyout", str(self.root / "leaf-key"), "-out", str(leaf)], check=True, capture_output=True)
        csr = self.root / "intermediate.csr"; intermediate = self.root / "intermediate.pem"
        subprocess.run(["openssl", "req", "-new", "-key", str(self.root / "key"), "-subj", "/CN=Intermediate", "-out", str(csr)], check=True, capture_output=True)
        ext = self.root / "ca-ext"; ext.write_text("basicConstraints=critical,CA:TRUE\n")
        subprocess.run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(self.root / "ca"), "-CAkey", str(self.root / "key"), "-CAcreateserial", "-extfile", str(ext), "-days", "1", "-out", str(intermediate)], check=True, capture_output=True)
        for certificate in [leaf, intermediate]:
            pem = certificate.read_text()
            cases.append({"pem": pem, "fingerprint_sha256": hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()})
        for ca in cases:
            with self.assertRaises(Exception): self.apply([ca])
            self.assertEqual((self.state / "ownership.json").read_bytes(), before)
        with self.assertRaises(Exception): self.apply([self.ca] * 33)
        with self.assertRaises(Exception): self.apply([self.ca, self.ca])
    def test_recovers_both_interrupted_addition_and_removal(self):
        def fail(): raise RuntimeError("interrupted trust-store update")
        with self.assertRaises(RuntimeError): trust.reconcile([self.ca], self.state, self.cadir, fail)
        self.assertTrue(json.loads((self.state / "ownership.json").read_text())["dirty"])
        self.assertTrue(self.apply([self.ca]))
        with self.assertRaises(RuntimeError): trust.reconcile([], self.state, self.cadir, fail)
        self.assertTrue(self.apply([]))
        self.assertEqual(json.loads((self.state / "ownership.json").read_text())["owned"], [])
    def test_restores_owned_root_after_os_rootfs_replacement(self):
        self.apply([self.ca])
        for path in self.cadir.iterdir(): path.unlink()
        self.assertTrue(self.apply([self.ca]))
        self.assertEqual(len(list(self.cadir.iterdir())), 1)
    def test_rejects_symlinks_and_oversize_requests(self):
        self.cadir.mkdir()
        victim = self.root / "victim"; victim.write_text("keep")
        (self.cadir / ("betterframe-" + self.ca["fingerprint_sha256"] + ".crt")).symlink_to(victim)
        with self.assertRaises(ValueError): self.apply([self.ca])
        self.assertEqual(victim.read_text(), "keep")
        request = self.root / "request"; request.symlink_to(victim)
        with self.assertRaises(OSError): trust.read_request(request)
        request.unlink(); request.write_bytes(b"x" * (trust.MAX_REQUEST + 1))
        with self.assertRaises(ValueError): trust.read_request(request)
    def test_real_trust_bundle_accepts_only_the_signed_hostname_and_valid_leaf_until_removal(self):
        etc = self.root / "etc-certs"; etc.mkdir()
        hooks = self.root / "hooks"; hooks.mkdir()
        config = self.root / "certs.conf"; config.write_text(Path("/etc/ca-certificates.conf").read_text())
        def update():
            subprocess.run(["/usr/sbin/update-ca-certificates", "--certsconf", str(config), "--localcertsdir", str(self.cadir), "--etccertsdir", str(etc), "--hooksdir", str(hooks)], check=True, capture_output=True)
        ext = self.root / "extensions"; ext.write_text("subjectAltName=DNS:internal.test\n")
        subprocess.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=internal.test", "-keyout", str(self.root / "leaf.key"), "-out", str(self.root / "leaf.csr")], check=True, capture_output=True)
        for name, days in [("leaf", "1"), ("expired", "-1")]:
            subprocess.run(["openssl", "x509", "-req", "-in", str(self.root / "leaf.csr"), "-CA", str(self.root / "ca"), "-CAkey", str(self.root / "key"), "-CAcreateserial", "-days", days, "-extfile", str(ext), "-out", str(self.root / name)], check=True, capture_output=True)
        trust.reconcile([self.ca], self.state, self.cadir, update)
        def verify(host, leaf="leaf"):
            return subprocess.run(["openssl", "verify", "-CAfile", str(etc / "ca-certificates.crt"), "-verify_hostname", host, str(self.root / leaf)], capture_output=True).returncode
        self.assertEqual(verify("internal.test"), 0)
        self.assertNotEqual(verify("wrong.test"), 0)
        self.assertNotEqual(verify("internal.test", "expired"), 0)
        trust.reconcile([], self.state, self.cadir, update)
        self.assertNotEqual(verify("internal.test"), 0)

    def test_claimed_request_cannot_delete_a_newer_replacement(self):
        request = self.root / "request.json"
        request.write_text(json.dumps({"trusted_cas": [self.ca]}))
        def replace_while_applying():
            request.write_text(json.dumps({"trusted_cas": []}))
            self.update()
        trust.main(self.state, request, self.cadir, replace_while_applying, lambda: None)
        self.assertTrue(request.exists())
        self.assertFalse((self.state / "processing.json").exists())
        trust.main(self.state, request, self.cadir, self.update, lambda: None)
        self.assertEqual(list(self.cadir.iterdir()), [])
        self.assertEqual(json.loads((self.state / "status.json").read_text())["revision"], trust.revision([]))

    def test_failure_consumes_only_the_claim_and_preserves_the_next_request(self):
        request = self.root / "request.json"
        request.write_text(json.dumps({"trusted_cas": [self.ca]}))
        def fail_with_replacement():
            request.write_text(json.dumps({"trusted_cas": []}))
            raise RuntimeError("interrupted update")
        with self.assertRaises(RuntimeError): trust.main(self.state, request, self.cadir, fail_with_replacement, lambda: None)
        self.assertTrue(request.exists()); self.assertFalse((self.state / "processing.json").exists())
        trust.main(self.state, request, self.cadir, self.update, lambda: None)
        self.assertEqual(list(self.cadir.iterdir()), [])

    def test_abandoned_claim_recovers_and_invalid_claim_does_not_retry_forever(self):
        self.state.mkdir()
        claimed = self.state / "processing.json"
        claimed.write_text(json.dumps({"trusted_cas": [self.ca]}))
        request = self.root / "request.json"
        trust.main(self.state, request, self.cadir, self.update, lambda: None)
        self.assertFalse(claimed.exists())
        self.assertEqual(len(list(self.cadir.iterdir())), 1)
        request.write_text("malformed JSON")
        with self.assertRaises(ValueError): trust.main(self.state, request, self.cadir, self.update, lambda: None)
        self.assertFalse(request.exists()); self.assertFalse(claimed.exists())
        self.assertEqual(json.loads((self.state / "status.json").read_text())["state"], "error")

    def test_expired_roots_do_not_block_other_assignments_or_removals(self):
        expired = self.root / "expired-root.pem"
        subprocess.run(["openssl", "x509", "-in", str(self.root / "ca"), "-signkey", str(self.root / "key"), "-days", "-1", "-out", str(expired)], check=True, capture_output=True)
        pem = expired.read_text()
        bad_time = {"pem": pem, "fingerprint_sha256": hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()}
        request = self.root / "request.json"
        request.write_text(json.dumps({"trusted_cas": [self.ca, bad_time]}))
        trust.main(self.state, request, self.cadir, self.update, lambda: None)
        report = json.loads((self.state / "status.json").read_text())
        self.assertEqual(report["state"], "error"); self.assertIn(bad_time["fingerprint_sha256"], report["message"])
        self.assertEqual(len(list(self.cadir.iterdir())), 1)
        request.write_text(json.dumps({"trusted_cas": [bad_time]}))
        trust.main(self.state, request, self.cadir, self.update, lambda: None)
        self.assertEqual(list(self.cadir.iterdir()), [])
        errors = []
        self.assertEqual(trust.validate([self.ca], self.state, errors, now=0), {})
        self.assertEqual(len(errors), 1)

    def test_standalone_setup_embeds_identical_helper_and_units(self):
        for function, file in [("write_trusted_ca_helper", "betterframe-trusted-cas.py"), ("write_trusted_ca_service", "betterframe-trusted-cas.service"), ("write_trusted_ca_path", "betterframe-trusted-cas.path")]:
            result = subprocess.run(["bash", "-c", 'source "$1"; "$2"', "test", str(ROOT / "setup.sh"), function], check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout, (ROOT / "deploy/systemd" / file).read_text())

if __name__ == "__main__": unittest.main()
