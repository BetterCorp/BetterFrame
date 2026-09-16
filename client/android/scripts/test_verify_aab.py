"""Verify native ABI and page-alignment gates without an Android SDK."""
import importlib.util
import io
from pathlib import Path
import struct
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('verify_aab', Path(__file__).with_name('verify-aab.py'))
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


def elf(abi, alignment=16384):
    elf_class, machine, _ = VERIFY.ABI_ELF[abi]
    header, entry = (52, 32) if elf_class == 1 else (64, 56)
    data = bytearray(header + entry)
    data[:7] = b'\x7fELF' + bytes((elf_class, 1, 1))
    struct.pack_into('<HI', data, 18, machine, 1)
    if elf_class == 1:
        struct.pack_into('<I', data, 28, header)
        struct.pack_into('<HHH', data, 40, header, entry, 1)
        struct.pack_into('<I', data, header + 28, alignment)
    else:
        struct.pack_into('<Q', data, 32, header)
        struct.pack_into('<HHH', data, 52, header, entry, 1)
        struct.pack_into('<Q', data, header + 48, alignment)
    struct.pack_into('<I', data, header, 1)
    return data


class VerifyAabTest(unittest.TestCase):
    def test_accepts_all_supported_abis(self):
        for abi in VERIFY.ABI_ELF:
            with self.subTest(abi=abi):
                self.assertEqual(VERIFY.elf_alignment(elf(abi), abi), 16384)

    def test_rejects_incorrect_class_or_machine(self):
        for actual in VERIFY.ABI_ELF:
            for claimed in VERIFY.ABI_ELF:
                if actual != claimed:
                    with self.subTest(actual=actual, claimed=claimed), self.assertRaises(ValueError):
                        VERIFY.elf_alignment(elf(actual), claimed)

    def test_rejects_truncated_headers_and_tables(self):
        for abi in VERIFY.ABI_ELF:
            data = elf(abi)
            for length in (0, 6, 40, len(data) - 1):
                with self.subTest(abi=abi, length=length), self.assertRaises(ValueError):
                    VERIFY.elf_alignment(data[:length], abi)

    def test_rejects_invalid_header_sizes_offsets_and_versions(self):
        for abi in VERIFY.ABI_ELF:
            is32 = abi == 'armeabi-v7a'
            mutations = [(6, '<B', 0), (20, '<I', 0),
                         (40 if is32 else 52, '<H', 0),
                         (42 if is32 else 54, '<H', 0),
                         (28 if is32 else 32, '<I' if is32 else '<Q', 0),
                         (28 if is32 else 32, '<I' if is32 else '<Q', 0xffffffff)]
            for offset, fmt, value in mutations:
                with self.subTest(abi=abi, offset=offset, value=value):
                    data = elf(abi)
                    struct.pack_into(fmt, data, offset, value)
                    with self.assertRaises(ValueError):
                        VERIFY.elf_alignment(data, abi)

    def test_rejects_missing_load_segments(self):
        for abi in VERIFY.ABI_ELF:
            data = elf(abi)
            struct.pack_into('<I', data, 52 if abi == 'armeabi-v7a' else 64, 0)
            with self.subTest(abi=abi), self.assertRaisesRegex(ValueError, 'no LOAD'):
                VERIFY.elf_alignment(data, abi)

    def test_rejects_small_and_non_power_of_two_alignment(self):
        for abi in VERIFY.ABI_ELF:
            for alignment in (0, 4096, 16385):
                with self.subTest(abi=abi, alignment=alignment), self.assertRaisesRegex(ValueError, 'power of two'):
                    VERIFY.elf_alignment(elf(abi, alignment), abi)

    def test_rejects_incongruent_load_address(self):
        for abi in VERIFY.ABI_ELF:
            data = elf(abi)
            struct.pack_into('<I' if abi == 'armeabi-v7a' else '<Q', data,
                             60 if abi == 'armeabi-v7a' else 80, 1)
            with self.subTest(abi=abi), self.assertRaisesRegex(ValueError, 'offset/address'):
                VERIFY.elf_alignment(data, abi)

    def verify_archive(self, libraries):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            for abi, data in libraries.items():
                archive.writestr(f'base/lib/{abi}/libbetterframe.so', data)
        with zipfile.ZipFile(stream) as archive:
            return VERIFY.verify_native_libraries(archive)

    def test_bundle_requires_all_three_architectures(self):
        libraries = {abi: elf(abi) for abi in VERIFY.ABI_ELF}
        self.assertEqual(self.verify_archive(libraries), 16384)
        for missing in libraries:
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, 'bundle must contain'):
                self.verify_archive({abi: data for abi, data in libraries.items() if abi != missing})

    def test_bundle_rejects_unknown_abi(self):
        libraries = {abi: elf(abi) for abi in VERIFY.ABI_ELF}
        libraries['armeabi'] = elf('armeabi-v7a')
        with self.assertRaisesRegex(ValueError, 'unsupported native ABI'):
            self.verify_archive(libraries)


if __name__ == '__main__':
    unittest.main()
