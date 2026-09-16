#!/usr/bin/env python3
"""Capture the real foreground app from a demo Android device. Review before committing."""
import argparse
from pathlib import Path
import re
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--serial', required=True)
p.add_argument('--family', choices=['phone', 'tablet', 'tv'], required=True)
p.add_argument('--language', default='en-US')
p.add_argument('--name', required=True)
a = p.parse_args()
for value in (a.language, a.name):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        p.error('language and name must contain only letters, digits, underscores or hyphens')
path = Path(__file__).resolve().parents[1] / 'play/screenshots' / a.language / a.family / (a.name + '.png')
if path.exists():
    p.error('capture already exists; use a distinct name')
result = subprocess.run(['adb', '-s', a.serial, 'exec-out', 'screencap', '-p'], check=True, capture_output=True)
if not result.stdout.startswith(b'\x89PNG\r\n\x1a\n'):
    raise ValueError('device did not return a PNG screenshot')
path.parent.mkdir(parents=True, exist_ok=True)
with path.open('xb') as output:
    output.write(result.stdout)
print(f'Captured {path}; review for sensitive data and store suitability before committing.')
