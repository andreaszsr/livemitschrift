"""Withdraw a server notebook without putting its publisher key on the command line."""
import argparse
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('read_url')
    parser.add_argument('--key-file', required=True, type=Path)
    args = parser.parse_args()
    url = urlsplit(args.read_url)
    identity = url.path.removeprefix('/notebook/')
    local = url.hostname in ('localhost', '127.0.0.1', '::1')
    if url.username or url.password or url.query or url.fragment or not re.fullmatch('[a-f0-9]{64}', identity) or not (url.scheme == 'https' or (url.scheme == 'http' and local)):
        parser.error('Use the complete HTTPS notebook link, or HTTP on loopback.')
    key = args.key_file.read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}', key): parser.error('Invalid publisher key file.')
    request = Request(f'{url.scheme}://{url.netloc}/api/notebook/{identity}', method='DELETE', headers={'X-LiveMitschrift-Publisher-Key': key})
    with build_opener(NoRedirect()).open(request, timeout=30) as response:
        if response.status != 204: raise SystemExit('Withdrawal was not confirmed.')
    print('Notebook withdrawn. Local notes are unchanged; use a new notebook identity to publish again.')


if __name__ == '__main__': main()
