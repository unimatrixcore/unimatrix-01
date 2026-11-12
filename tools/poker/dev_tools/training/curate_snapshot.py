#!/usr/bin/env python3
"""Create a consistent SQLite snapshot and inventory without changing the source."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('database', type=Path)
    parser.add_argument('snapshot', type=Path)
    args = parser.parse_args()
    if args.snapshot.exists():
        parser.error('snapshot already exists; choose a new path')
    args.snapshot.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        dest = sqlite3.connect(args.snapshot)
        try:
            source.backup(dest)
            result = dest.execute('PRAGMA integrity_check').fetchone()[0]
            if result != 'ok':
                raise RuntimeError(f'snapshot integrity check failed: {result}')
            columns = {row[1] for row in dest.execute('PRAGMA table_info(images)')}
            required = {'id', 'filename', 'phash', 'label', 'region_id', 'source_id'}
            if not required <= columns:
                raise RuntimeError(f'missing image columns: {sorted(required - columns)}')
            counts = dict(dest.execute("SELECT 'images', count(*) FROM images UNION ALL SELECT 'nonempty', count(*) FROM images WHERE label IS NOT NULL AND label != '' UNION ALL SELECT 'missing_source', count(*) FROM images WHERE source_id IS NULL").fetchall())
        finally:
            dest.close()
    finally:
        source.close()
    digest = hashlib.sha256(args.snapshot.read_bytes()).hexdigest()
    print(json.dumps({'snapshot': str(args.snapshot), 'sha256': digest, 'counts': counts}, indent=2))


if __name__ == '__main__':
    main()
