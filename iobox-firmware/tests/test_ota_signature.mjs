import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = resolve(root, '.pio/libdeps/iobox_wifi/Crypto');
const temp = mkdtempSync(join(tmpdir(), 'bf-ota-signature-'));
try {
  const exe = join(temp, 'test-ota');
  execFileSync('g++', ['-std=c++11', '-O2', '-ffunction-sections', '-fdata-sections',
    '-Wl,--gc-sections', `-I${lib}`, `-I${join(root, 'include')}`,
    join(root, 'tests/ota_signature_test.cpp'),
    ...['Ed25519', 'Curve25519', 'SHA512', 'Hash', 'Crypto', 'BigNumberUtil'].map(name => join(lib, `${name}.cpp`)),
    '-o', exe], { stdio: 'inherit' });
  const keys = generateKeyPairSync('ed25519');
  const digest = createHash('sha256').update('ioBOX test firmware bytes').digest('hex');
  const signature = sign(null, Buffer.from(digest, 'utf8'), keys.privateKey);
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  execFileSync(exe, [digest, signature.toString('hex'), publicKey.toString('hex')], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
