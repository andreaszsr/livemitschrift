"""Create deployment configuration and a publisher secret without displaying it."""
import argparse
import os
from pathlib import Path
import secrets
import shutil


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]/'deploy'
    if any((args.directory/name).exists() for name in ('compose.yaml', 'Caddyfile', 'secrets/publisher.key')):
        raise SystemExit('Destination contains deployment files or a key; refusing to overwrite.')
    args.directory.mkdir(parents=True, exist_ok=True)
    for filename in ('compose.yaml', 'Caddyfile'):
        target = args.directory/filename
        if target.exists():
            raise SystemExit('Destination contains deployment files; refusing to overwrite.')
        shutil.copyfile(source/filename, target)
    env = args.directory/'.env'
    if not env.exists(): shutil.copyfile(source/'.env.example', env)
    # Optional operator content (privacy notice), mounted read-only into the backend.
    config = args.directory/'config'; config.mkdir(exist_ok=True)
    shutil.copyfile(source/'datenschutz.example.html', config/'datenschutz.example.html')
    private = args.directory/'secrets'; private.mkdir(exist_ok=True); private.chmod(0o700)
    key = private/'publisher.key'
    try:
        descriptor = os.open(key, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise SystemExit('Publisher key already exists; it was not modified.')
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(secrets.token_hex(32)+'\n'); handle.flush(); os.fsync(handle.fileno())
    key.chmod(0o444)  # Compose bind-mounts this one file; its host directory stays 0700.
    env.chmod(0o600)
    print('Deployment files prepared. Set DOMAIN, ACME_EMAIL and LIVEMITSCHRIFT_IMAGE in .env.')
    print('The publisher key stays in secrets/publisher.key; configure that value in the Mac app.')


if __name__ == '__main__': main()
