"""Validate a version tag and require a license file for publication."""
import argparse
import json
import os
from pathlib import Path
import re
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-license', action='store_true')
    args = parser.parse_args()
    versions = [json.loads((ROOT/'package.json').read_text())['version'],
                json.loads((ROOT/'apps/desktop/src-tauri/tauri.conf.json').read_text())['version'],
                tomllib.loads((ROOT/'apps/desktop/src-tauri/Cargo.toml').read_text())['package']['version'],
                tomllib.loads((ROOT/'backend/pyproject.toml').read_text())['project']['version']]
    if len(set(versions)) != 1 or not re.fullmatch(r'\d+\.\d+\.\d+', versions[0]):
        raise SystemExit('Release versions do not match.')
    tag = os.environ.get('GITHUB_REF_NAME')
    if tag and os.environ.get('GITHUB_REF_TYPE') == 'tag' and tag != 'v'+versions[0]:
        raise SystemExit('Git tag does not match the application version.')
    if args.require_license and not (ROOT/'LICENSE').is_file():
        raise SystemExit('LICENSE is required before publishing.')
    print('Release version verified:', versions[0])


if __name__ == '__main__': main()
