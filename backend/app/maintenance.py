"""Host-admin SQLite backup and stopped-server restore; no public endpoint."""
import argparse
import fcntl
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

from .settings import Settings, server_directory


def verify(path: Path) -> None:
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise ValueError('SQLite integrity check failed.')
        if db.execute('PRAGMA user_version').fetchone() not in ((1,), (2,)):
            raise ValueError('Unsupported server backup version.')
        required = {'notebooks', 'pages', 'strokes', 'commits', 'assets', 'pdf_pages', 'withdrawn'}
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not required <= tables:
            raise ValueError('Not a LiveMitschrift server backup.')


def backup(directory: Path, destination: Path) -> None:
    with sqlite3.connect(f'file:{directory / "notebooks.sqlite3"}?mode=ro', uri=True) as source, sqlite3.connect(destination) as target:
        source.backup(target)
    verify(destination)
    with destination.open('rb') as handle:
        shutil.copyfileobj(handle, sys.stdout.buffer)


def restore(directory: Path, destination: Path) -> None:
    # The running server holds this lock for its entire lifetime. Never replace
    # a live SQLite file, even when an operator accidentally skips `compose stop`.
    with (directory / '.server.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError('Stop the backend before restoring.') from error
        size = 0
        with destination.open('wb') as handle:
            while chunk := sys.stdin.buffer.read(1024 * 1024):
                size += len(chunk)
                if size > Settings.configured().max_database_bytes:
                    raise ValueError('Backup exceeds the configured database quota.')
                handle.write(chunk)
            handle.flush(); os.fsync(handle.fileno())
        verify(destination)
        if any((directory / ('notebooks.sqlite3' + suffix)).exists() for suffix in ('-wal', '-journal')):
            raise ValueError('Database has an outstanding journal; recover it before restoring.')
        os.replace(destination, directory / 'notebooks.sqlite3')
    print('Server backup restored. Start the backend again.')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['backup', 'restore'])
    parser.add_argument('--replace', action='store_true', help='Required to replace a stopped server database.')
    args = parser.parse_args()
    if args.operation == 'restore' and not args.replace:
        parser.error('Restore requires --replace; take a current backup first.')
    directory = server_directory()
    with tempfile.TemporaryDirectory(prefix='maintenance-', dir=directory) as temporary:
        destination = Path(temporary)/'notebooks.sqlite3'
        try:
            (backup if args.operation == 'backup' else restore)(directory, destination)
        except (ValueError, OSError, sqlite3.Error) as error:
            raise SystemExit(str(error)) from None


if __name__ == '__main__': main()
