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


# ELF class, e_machine, minimum LOAD alignment. Require the same 16-KB
# alignment for every ABI to preserve the release metadata guarantee.
ABI_ELF = {'armeabi-v7a': (1, 40, 16384), 'arm64-v8a': (2, 183, 16384),
           'x86_64': (2, 62, 16384)}


def elf_alignment(data, abi):
    if abi not in ABI_ELF:
        raise ValueError(f'unsupported native ABI: {abi}')
    elf_class, machine, minimum = ABI_ELF[abi]
    header_size, entry_size = (52, 32) if elf_class == 1 else (64, 56)
    if len(data) < header_size:
        raise ValueError('truncated native ELF header')
    if data[:7] != b'\x7fELF' + bytes((elf_class, 1, 1)):
        raise ValueError(f'native ELF class/encoding does not match {abi}')
    if struct.unpack_from('<H', data, 18)[0] != machine:
        raise ValueError(f'native ELF machine does not match {abi}')
    if struct.unpack_from('<I', data, 20)[0] != 1:
        raise ValueError('invalid native ELF version')
    if elf_class == 1:
        phoff = struct.unpack_from('<I', data, 28)[0]
        ehsize, entsize, count = struct.unpack_from('<HHH', data, 40)
    else:
        phoff = struct.unpack_from('<Q', data, 32)[0]
        ehsize, entsize, count = struct.unpack_from('<HHH', data, 52)
    if ehsize != header_size or entsize != entry_size:
        raise ValueError('invalid native ELF header sizes')
    if phoff < header_size or phoff + count * entsize > len(data):
        raise ValueError('truncated or invalid native program header table')
    loads = []
    for index in range(count):
        offset = phoff + index * entsize
        kind = struct.unpack_from('<I', data, offset)[0]
        if kind == 1:
            if elf_class == 1:
                file_offset, vaddr = struct.unpack_from('<II', data, offset + 4)
                align = struct.unpack_from('<I', data, offset + 28)[0]
            else:
                file_offset, vaddr = struct.unpack_from('<QQ', data, offset + 8)
                align = struct.unpack_from('<Q', data, offset + 48)[0]
            if align < minimum or align & (align - 1):
                raise ValueError(f'native LOAD alignment for {abi} must be a power of two >= {minimum}')
            if file_offset % align != vaddr % align:
                raise ValueError('native LOAD offset/address alignment mismatch')
            loads.append(align)
    if not loads:
        raise ValueError('native library has no LOAD segments')
    return min(loads)


def verify_native_libraries(archive):
    abis, alignments = set(), []
    for name in archive.namelist():
        if '/lib/' in name and name.endswith('.so'):
            abi = name.split('/lib/', 1)[1].split('/', 1)[0]
            abis.add(abi)
            alignments.append(elf_alignment(archive.read(name), abi))
    if abis != set(ABI_ELF):
        raise ValueError('bundle must contain armeabi-v7a, arm64-v8a and x86_64')
    return min(alignments)


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
    with zipfile.ZipFile(bundle) as archive:
        alignment = verify_native_libraries(archive)
    with bundle.open('rb') as stream:
        metadata['aabSha256'] = hashlib.file_digest(stream,'sha256').hexdigest()
    metadata.update(targetSdk=target,nativePageAlignment=alignment,nativeAbis=sorted(ABI_ELF))
    metadata_path.write_text(json.dumps(metadata,indent=2)+'\n')


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--metadata',type=Path,required=True)
    p.add_argument('--bundletool',type=Path,required=True)
    p.add_argument('--certificate-sha256',required=True)
    a=p.parse_args()
    verify(a.bundle,a.metadata,a.bundletool,a.certificate_sha256)
