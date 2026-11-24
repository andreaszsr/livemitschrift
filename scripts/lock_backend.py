"""Check direct runtime pins, or deliberately refresh the complete wheel-hash lock."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT/'backend/requirements.lock'


def canonical(name: str) -> str:
    return re.sub(r'[-_.]+', '-', name).lower()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--update', action='store_true', help='Resolve with this Python interpreter and fetch published wheel hashes.')
    args = parser.parse_args()
    dependencies = tomllib.loads((ROOT/'backend/pyproject.toml').read_text())['project']['dependencies']
    direct = {}
    for requirement in dependencies:
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)', requirement)
        if not match:
            raise SystemExit('Runtime dependencies must have exact version pins.')
        direct[canonical(match[1])] = match[2]
    if args.update:
        with tempfile.TemporaryDirectory() as temporary:
            report = Path(temporary)/'resolved.json'
            subprocess.run([sys.executable, '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--only-binary=:all:', '--report', str(report), *dependencies], check=True)
            packages = json.loads(report.read_text())['install']
        lines = ['# Generated with Python 3.14: python scripts/lock_backend.py --update',
                 '# Review version changes and audits before committing. All published wheels are hashed.']
        for package in sorted(packages, key=lambda item: canonical(item['metadata']['name'])):
            name, version = canonical(package['metadata']['name']), package['metadata']['version']
            with urlopen(f'https://pypi.org/pypi/{name}/{version}/json', timeout=30) as response:
                files = json.load(response)['urls']
            hashes = sorted({file['digests']['sha256'] for file in files if file['packagetype'] == 'bdist_wheel' and not file.get('yanked')})
            if not hashes:
                raise SystemExit('No usable wheels for '+name)
            lines.append(name+'=='+version+' \\')
            lines.extend('    --hash=sha256:'+value+(' \\' if index+1 < len(hashes) else '') for index, value in enumerate(hashes))
        LOCK.write_text('\n'.join(lines)+'\n')
    locked = {canonical(name): version for name, version in re.findall(r'^([A-Za-z0-9_.-]+)==([^\s\\]+)', LOCK.read_text(), re.M)}
    if any(locked.get(name) != version for name, version in direct.items()):
        raise SystemExit('Direct dependencies and requirements.lock differ; refresh and audit the lock.')
    print('Backend runtime pins match the hashed lock.')


if __name__ == '__main__': main()
