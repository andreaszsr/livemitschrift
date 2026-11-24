"""Import CI-only signing material; never logs certificate data or passwords."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess


def run(*arguments: str) -> bytes:
    result = subprocess.run(arguments, capture_output=True)
    if result.returncode:
        # Commands contain temporary keychain/certificate passwords. Never let
        # CalledProcessError print their complete argument list in a CI log.
        raise SystemExit(f'CI signing command {arguments[0]} {arguments[1]} failed (exit {result.returncode}).')
    return result.stdout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    root = Path(os.environ['RUNNER_TEMP'])/'livemitschrift-signing'
    keychain = root/'release.keychain-db'
    if args.cleanup:
        if keychain.exists(): run('security', 'delete-keychain', str(keychain))
        for filename in ('certificate.p12', 'AuthKey.p8', 'config.json'):
            (root/filename).unlink(missing_ok=True)
        return
    required = ('APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_PRIVATE_KEY')
    if any(not os.environ.get(name) for name in required):
        raise SystemExit('Configure all documented Apple release secrets before publishing the macOS download.')
    root.mkdir(mode=0o700, exist_ok=True)
    certificate = root/'certificate.p12'; certificate.write_bytes(base64.b64decode(os.environ['APPLE_CERTIFICATE'], validate=True)); certificate.chmod(0o600)
    private = root/'AuthKey.p8'; private.write_text(os.environ['APPLE_API_PRIVATE_KEY']); private.chmod(0o600)
    password = secrets.token_urlsafe(32)
    run('security', 'create-keychain', '-p', password, str(keychain))
    run('security', 'set-keychain-settings', '-lut', '21600', str(keychain))
    run('security', 'unlock-keychain', '-p', password, str(keychain))
    run('security', 'import', str(certificate), '-k', str(keychain), '-P', os.environ['APPLE_CERTIFICATE_PASSWORD'], '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild')
    run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, str(keychain))
    run('security', 'list-keychains', '-d', 'user', '-s', str(keychain))
    config = root/'config.json'; config.write_text(json.dumps({'bundle': {'macOS': {'signingIdentity': os.environ['APPLE_SIGNING_IDENTITY']}}}))
    with Path(os.environ['GITHUB_ENV']).open('a') as handle:
        handle.write(f'MACOS_RELEASE_CONFIG={config}\nAPPLE_API_KEY_PATH={private}\n')
    print('CI signing keychain prepared; credentials were not displayed.')


if __name__ == '__main__': main()
