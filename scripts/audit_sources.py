"""Check the public source manifest and optionally export it for a secret scan."""
import argparse
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_SUFFIXES = ('.key', '.pem', '.p12', '.pfx', '.sqlite3', '.sqlite3-wal', '.sqlite3-shm')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', type=Path)
    args = parser.parse_args()
    paths = subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'], cwd=ROOT).decode().split('\0')
    exported = 0
    if args.export:
        if args.export.exists() and any(args.export.iterdir()):
            raise SystemExit('Export directory must be empty.')
        args.export.mkdir(parents=True, exist_ok=True)
    for name in filter(None, paths):
        path = ROOT/name
        if not path.is_file(): continue
        private = path.name == '.env' or (path.name.startswith('.env.') and path.name != '.env.example') or name.endswith(PRIVATE_SUFFIXES) or any(part in {'secrets','backups','.venv','.tools','node_modules','target'} for part in Path(name).parts)
        if private or not path.resolve().is_relative_to(ROOT):
            raise SystemExit('Private or external file in source manifest: '+name)
        if args.export:
            destination = args.export/name; destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
        exported += 1
    print(f'SOURCE_PASS {exported} source files; no private database/configuration/key paths.')


if __name__ == '__main__': main()
