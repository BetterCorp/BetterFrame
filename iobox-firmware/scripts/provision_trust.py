#!/usr/bin/env python3
"""Generate a firmware header from operator-verified PUBLIC trust material."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def trust_header(ca_pem: str, signing_pem: str) -> str:
    if 'PRIVATE KEY' in ca_pem or 'PRIVATE KEY' in signing_pem:
        raise ValueError('Only public certificates and signing keys are accepted')
    subprocess.run(['openssl', 'x509', '-noout', '-checkend', '0'],
                   input=ca_pem.encode(), check=True, capture_output=True)
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'],
                         input=signing_pem.encode(), check=True, capture_output=True).stdout
    # RFC 8410 Ed25519 SubjectPublicKeyInfo: algorithm OID 1.3.101.112, 32-byte key.
    prefix = bytes.fromhex('302a300506032b6570032100')
    if len(der) != 44 or not der.startswith(prefix):
        raise ValueError('Firmware signing public key must be Ed25519')
    return ('#pragma once\n// Generated public trust material; verify its provenance before building.\n'
            f'#define BF_TLS_CA_PEM {json.dumps(ca_pem)}\n'
            f'#define BF_OTA_PUBLIC_KEY_HEX "{der[12:].hex()}"\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ca', type=Path, help='Verified PEM root certificate')
    parser.add_argument('--signing-public-key', type=Path, help='Verified firmware signing PUBLIC PEM')
    parser.add_argument('--output', type=Path, default=Path('include/trust_config_local.h'))
    args = parser.parse_args()
    ca = args.ca.read_text() if args.ca else os.environ.get('BF_IOBOX_TLS_CA_PEM', '')
    signing = args.signing_public_key.read_text() if args.signing_public_key else os.environ.get('BF_IOBOX_OTA_PUBLIC_KEY_PEM', '')
    if not ca or not signing:
        parser.error('Both CA and signing public key are required; supply files or BF_IOBOX_*_PEM environment variables')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(trust_header(ca, signing))
    print(f'Public trust header generated: {args.output}')


if __name__ == '__main__':
    main()
