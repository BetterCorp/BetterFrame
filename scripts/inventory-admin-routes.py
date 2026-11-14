#!/usr/bin/env python3
"""Refresh the BP migration inventory; preserve reviewed dispositions by method/path.

Static literal app.METHOD registrations only. Middleware, proxy rewrites, and
WebSocket upgrades need the separate manual audit described in the migration plan.
New routes deliberately remain NEEDS_REVIEW rather than guessing a migration policy.
"""
import argparse
import csv
import io
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / 'docs/betterportal-admin-route-inventory.csv'
FIELDS = ['method', 'legacy_path', 'source', 'source_line', 'proposed_disposition', 'wave']
CALL = re.compile(r'\bapp\.(get|post|put|patch|delete|head|options|all)\s*\(')
LITERAL = re.compile(r'''\s*(["'])([^"'\n]+)\1\s*,''')


def render():
    with INVENTORY.open(newline='') as handle:
        previous = {(row['method'], row['legacy_path']): row for row in csv.DictReader(handle)}
    rows = []
    seen = set()
    for source in sorted((ROOT / 'server/src/plugins/service-admin-http').glob('*.ts')):
        content = source.read_text()
        for call in CALL.finditer(content):
            literal = LITERAL.match(content, call.end())
            line = content.count('\n', 0, call.start()) + 1
            if literal:
                paths = [literal[2]]
            elif content[call.end():].startswith('path,') and content[:call.start()].rstrip().endswith('for (const path of ["/admin/backup/download", "/admin/backup/restore"]) {'):
                paths = ['/admin/backup/download', '/admin/backup/restore']
            elif content[call.end():].startswith('`/api/displays/:id/${path}`,') and content[:call.start()].rstrip().endswith('for (const [path, type] of [["clear", "operator-clear"], ["restore", "operator-restore"]] as const) {'):
                paths = ['/api/displays/:id/clear', '/api/displays/:id/restore']
            else:
                raise ValueError(f'Unrecognized dynamic route requires manual inventory: {source}:{line}')
            for path in paths:
                method = call[1].upper()
                key = (method, path)
                if key in seen:
                    raise ValueError(f'Duplicate route requires manual review: {method} {path}')
                seen.add(key)
                old = previous.get(key, {})
                rows.append(dict(zip(FIELDS, [method, path, str(source.relative_to(ROOT)), str(line),
                    old.get('proposed_disposition', 'NEEDS_REVIEW: classify representation, callers, permissions and migration destination'),
                    old.get('wave', '0') ])))
    removed = sorted(set(previous) - seen)
    if removed:
        print('Removed registrations (review callers before retiring contracts):', file=sys.stderr)
        for method, path in removed:
            print(f'  {method} {path}', file=sys.stderr)
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(sorted(rows, key=lambda row: (row['legacy_path'], row['method'])))
    return output.getvalue(), len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if the committed inventory differs from source')
    args = parser.parse_args()
    result, count = render()
    if args.check:
        if INVENTORY.read_text() != result:
            sys.exit('Inventory is stale; run python3 scripts/inventory-admin-routes.py and review the diff.')
    else:
        INVENTORY.write_text(result)
    print(f'{count} literal admin-listener routes inventoried.')


if __name__ == '__main__':
    main()
