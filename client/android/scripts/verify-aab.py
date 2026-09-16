#!/usr/bin/env python3
"""Verify signed bundle identity, target API and 16-KB ELF alignment before Play upload."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile


def output(command):
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return result.stdout + result.stderr


def elf_alignment(data):
    if data[:6] != b'\x7fELF\x02\x01':
        raise ValueError('native library must be little-endian ELF64')
    phoff = struct.unpack_from('<Q', data, 32)[0]
    entsize, count = struct.unpack_from('<HH', data, 54)
    loads = []
    for index in range(count):
        offset = phoff + index * entsize
        kind = struct.unpack_from('<I', data, offset)[0]
        if kind == 1:
            align = struct.unpack_from('<Q', data, offset + 48)[0]
            if align < 16384 or align & (align - 1):
                raise ValueError('native LOAD segment is not 16-KB aligned')
            loads.append(align)
    if not loads:
        raise ValueError('native library has no LOAD segments')


def verify(bundle, metadata_path, bundletool, certificate):
    metadata = json.loads(metadata_path.read_text())
    result = output(['jarsigner','-J-Duser.language=en','-verify','-verbose','-certs',str(bundle)])
    if 'jar verified.' not in result or 'unsigned entries' in result:
        raise ValueError('bundle signature is missing or leaves unsigned entries')
    certs = output(['keytool','-J-Duser.language=en','-printcert','-jarfile',str(bundle)])
    digests = re.findall(r'SHA256:\s*([0-9A-Fa-f:]+)', certs)
    if len(digests) != 1 or digests[0].replace(':','').upper() != certificate.replace(':','').upper():
        raise ValueError('bundle signer differs from the pinned Android release certificate')
    output(['java','-jar',str(bundletool),'validate','--bundle='+str(bundle)])
    def manifest(xpath):
        return output(['java','-jar',str(bundletool),'dump','manifest','--bundle='+str(bundle),'--xpath='+xpath]).strip()
    if manifest('/manifest/@package') != 'cloud.betterportal.frame':
        raise ValueError('unexpected bundle application ID')
    if manifest('/manifest/@android:versionCode') != str(metadata['versionCode']) or manifest('/manifest/@android:versionName') != metadata['versionName']:
        raise ValueError('bundle version differs from verified APK')
    target = int(manifest('/manifest/uses-sdk/@android:targetSdkVersion'))
    if target < 36:
        raise ValueError('Google Play submissions require target API 36')
    abis = set()
    with zipfile.ZipFile(bundle) as archive:
        for name in archive.namelist():
            if '/lib/' in name and name.endswith('.so'):
                abi = name.split('/lib/',1)[1].split('/',1)[0]
                abis.add(abi)
                elf_alignment(archive.read(name))
    if abis != {'arm64-v8a','x86_64'}:
        raise ValueError('bundle must contain the two supported 64-bit ABIs')
    with bundle.open('rb') as stream:
        metadata['aabSha256'] = hashlib.file_digest(stream,'sha256').hexdigest()
    metadata.update(targetSdk=target,nativePageAlignment=16384)
    metadata_path.write_text(json.dumps(metadata,indent=2)+'\n')


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--metadata',type=Path,required=True)
    p.add_argument('--bundletool',type=Path,required=True)
    p.add_argument('--certificate-sha256',required=True)
    a=p.parse_args()
    verify(a.bundle,a.metadata,a.bundletool,a.certificate_sha256)
