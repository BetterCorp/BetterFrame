#!/usr/bin/env python3
"""Validate checked-in listing text/assets; --ready also requires owner decisions/screenshots."""
import argparse
import json
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def png(path):
    data=path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError(f'{path}: expected PNG')
    return (*struct.unpack('>II',data[16:24]),data[25])


def check(ready=False):
    config=json.loads((ROOT/'play/config.json').read_text())
    assert config['applicationId']=='cloud.betterportal.frame'
    assert config['defaultLanguage'] in config['languages']
    for lang in config['languages']:
        assert re.fullmatch(r'[a-z]{2,3}(-[A-Za-z]{2,4})?',lang)
        listing=ROOT/'play/listings'/lang
        for name,limit in [('title',30),('short-description',80),('full-description',4000),('release-notes',500)]:
            text=(listing/(name+'.txt')).read_text().strip()
            assert 0<len(text)<=limit, f'{lang}/{name} exceeds {limit} characters'
        for name,size in [('icon',(512,512)),('feature-graphic',(1024,500)),('tv-banner',(1280,720))]:
            path=ROOT/'play/assets'/lang/(name+'.png')
            width,height,colour=png(path)
            assert (width,height)==size, f'{path}: incorrect dimensions'
            assert colour==2, f'{path}: use opaque RGB PNG'
            if name=='icon': assert path.stat().st_size<=1024*1024
        if ready:
            for family,minimum in [('phone',2),('tablet',2),('tv',1)]:
                paths=list((ROOT/'play/screenshots'/lang/family).glob('*.png'))
                assert len(paths)>=minimum, f'{lang}: capture {minimum} approved {family} screenshots'
                for path in paths:
                    width,height,_=png(path)
                    assert min(width,height)>=320 and max(width,height)<=3840 and max(width,height)<=2*min(width,height)
                    if family=='tv': assert width*9==height*16
    keys={node.get('name') for node in ET.parse(ROOT/'app/src/main/res/values/strings.xml').getroot()}
    for path in (ROOT/'app/src/main/java').rglob('*.kt'):
        for key in re.findall(r'(?<!android\.)R\.string\.([a-z_0-9]+)',path.read_text()):
            assert key in keys, f'{path}: missing string {key}'
    if ready:
        assert config['listingApproved'] and config['screenshotsApproved'], 'Listing and screenshots need owner approval'
        assert config['supportEmail'] and '@' in config['supportEmail'], 'Set support email'
        assert config['privacyPolicyUrl'] and config['privacyPolicyUrl'].startswith('https://'), 'Set hosted privacy policy URL'
    print('Play metadata/assets validated' + ('; owner readiness verified' if ready else '; use --ready to check outstanding launch inputs'))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ready',action='store_true')
    check(parser.parse_args().ready)
