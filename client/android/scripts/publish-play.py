#!/usr/bin/env python3
"""Publish a verified release bundle to its fixed Play track; no credentials needed for --plan."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

PACKAGE = 'cloud.betterportal.frame'
BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + PACKAGE
UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/' + PACKAGE
VERSION = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(alpha|beta|dev)\.[0-9A-Za-z.-]+)?$')


def release_plan(version, channel, dev_track='internal'):
    match = VERSION.fullmatch(version)
    if not match or (channel == 'stable') != (match[4] is None):
        raise ValueError('version/channel mismatch; stable must be an unqualified release version')
    if channel not in ('stable', 'dev', 'beta'):
        raise ValueError('unknown release channel')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', dev_track) or dev_track.lower() == 'production':
        raise ValueError('development track must be internal or a named test track, never production')
    return {'packageName': PACKAGE, 'track': 'production' if channel == 'stable' else dev_track,
            'versionName': version, 'status': 'completed'}


def verify_artifact(bundle, metadata, version):
    data = json.loads(metadata.read_text())
    if data.get('applicationId') != PACKAGE or data.get('versionName') != version:
        raise ValueError('artifact identity does not match this release')
    code = data.get('versionCode')
    if type(code) is not int or not 1 <= code <= 2_100_000_000:
        raise ValueError('invalid artifact versionCode')
    with bundle.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != data.get('aabSha256'):
        raise ValueError('bundle digest does not match verified metadata')
    if data.get('targetSdk', 0) < 36 or data.get('nativePageAlignment') != 16384:
        raise ValueError('bundle has not passed target SDK and native alignment checks')
    return data


class Play:
    def __init__(self, token):
        if not token:
            raise ValueError('PLAY_ACCESS_TOKEN is required')
        self.token = token

    def request(self, method, path, data=None, bundle=None):
        body = bundle.read_bytes() if bundle else None if data is None else json.dumps(data).encode()
        url = (UPLOAD if bundle else BASE) + path
        request = urllib.request.Request(url, data=body, method=method, headers={
            'Authorization': 'Bearer ' + self.token,
            'Content-Type': 'application/octet-stream' if bundle else 'application/json',
        })
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            # Do not dump headers, tokens or Google account details into logs.
            raise RuntimeError(f'Google Play returned HTTP {error.code} for {method} {path.split("?")[0]}') from None


def publish(api, plan, bundle, metadata, notes):
    code = str(metadata['versionCode'])
    edit = api.request('POST', '/edits', {})['id']
    root = '/edits/' + urllib.parse.quote(edit, safe='')
    committed = False
    try:
        track_path = root + '/tracks/' + urllib.parse.quote(plan['track'], safe='')
        current = api.request('GET', track_path)
        releases = current.get('releases', [])
        current_codes = [int(code) for release in releases for code in release.get('versionCodes', [])]
        if current_codes and max(current_codes) > int(code):
            return 'skipped: a newer version is already on this track'
        bundles = api.request('GET', root + '/bundles').get('bundles', [])
        existing = next((item for item in bundles if str(item['versionCode']) == code), None)
        if existing:
            if existing.get('sha256') != metadata['aabSha256']:
                raise ValueError('versionCode already exists with a different bundle; create a new release run')
            if any(code in r.get('versionCodes', []) and r.get('status') == 'completed' for r in releases):
                return 'already published: matching bundle and completed track release'
        else:
            uploaded = api.request('POST', root + '/bundles?uploadType=media', bundle=bundle)
            if str(uploaded.get('versionCode')) != code or uploaded.get('sha256') != metadata['aabSha256']:
                raise ValueError('Google Play returned a different versionCode or bundle digest')
        release = {'name': plan['versionName'], 'versionCodes': [code], 'status': 'completed', 'releaseNotes': notes}
        api.request('PUT', track_path, {'track': plan['track'], 'releases': [release]})
        api.request('POST', root + ':validate', {})
        api.request('POST', root + ':commit', {})
        committed = True
        return 'submitted to ' + plan['track'] + '; Google review and managed-publishing settings determine availability'
    finally:
        if not committed:
            try:
                api.request('DELETE', root)
            except Exception:
                pass  # Do not mask the original error or retry an uncertain commit.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--channel', choices=['stable','dev','beta'], required=True)
    parser.add_argument('--dev-track', default='internal')
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--metadata', type=Path)
    parser.add_argument('--listing-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'play/listings')
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    plan = release_plan(args.version, args.channel, args.dev_track)
    print(json.dumps(plan))
    if args.plan:
        return
    if not args.bundle or not args.metadata:
        parser.error('--bundle and --metadata are required to publish')
    metadata = verify_artifact(args.bundle, args.metadata, args.version)
    notes = []
    for path in sorted(args.listing_dir.glob('*/release-notes.txt')):
        text = path.read_text().strip()
        if not 1 <= len(text) <= 500:
            raise ValueError('release notes must be 1–500 characters per language')
        notes.append({'language': path.parent.name, 'text': text})
    if not notes:
        raise ValueError('localized release notes are required')
    print(publish(Play(os.environ.get('PLAY_ACCESS_TOKEN')), plan, args.bundle, metadata, notes))


if __name__ == '__main__':
    main()
