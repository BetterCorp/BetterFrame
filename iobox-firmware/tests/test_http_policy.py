from pathlib import Path
import subprocess
import tempfile
import unittest


class HttpPolicyTests(unittest.TestCase):
    def test_firmware_request_origin_and_scope_contract(self):
        root = Path(__file__).parents[1]
        with tempfile.TemporaryDirectory(prefix='bf-http-policy-') as temp:
            exe = Path(temp) / 'http-policy'
            subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror',
                            '-I' + str(root / 'include'),
                            str(root / 'tests/http_policy_test.cpp'), '-o', str(exe)], check=True)
            subprocess.run([str(exe)], check=True)


if __name__ == '__main__':
    unittest.main()
