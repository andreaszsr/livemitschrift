"""Validated deployment settings; defaults bind the application to local use."""
from dataclasses import dataclass
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
# Canonical public repository; operators of modified versions set LIVEMITSCHRIFT_SOURCE_URL.
UPSTREAM_SOURCE = 'https://github.com/andreaszsr/livemitschrift'
NATIVE_ORIGINS = ('tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost')


def bounded_integer(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as error:
        raise ValueError(f'{name} must be an integer.') from error
    if not minimum <= value <= maximum:
        raise ValueError(f'{name} is outside its supported range.')
    return value


@dataclass(frozen=True)
class Settings:
    public_url: str | None = None
    # Optional link to the operator's privacy notice, shown in the reader menu.
    privacy_url: str | None = None
    # AGPL-3.0 section 13: readers get a link to the source of the running version.
    source_url: str = UPSTREAM_SOURCE
    max_connections: int = 128
    max_readers: int = 96
    max_http: int = 32
    max_database_bytes: int = 4 * 1024**3
    max_notebooks: int = 128
    max_notebooks_per_user: int = 20

    @classmethod
    def configured(cls) -> 'Settings':
        public = os.environ.get('LIVEMITSCHRIFT_PUBLIC_URL') or None
        if public:
            url = urlsplit(public)
            if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
                raise ValueError('LIVEMITSCHRIFT_PUBLIC_URL must be an HTTPS origin.')
            public = public.rstrip('/')
        privacy = os.environ.get('LIVEMITSCHRIFT_PRIVACY_URL') or None
        if privacy:
            url = urlsplit(privacy)
            if url.scheme != 'https' or not url.hostname or url.username or url.password or any(c in privacy for c in '"<>\' \n'):
                raise ValueError('LIVEMITSCHRIFT_PRIVACY_URL must be an HTTPS URL.')
        return cls(public_url=public, privacy_url=privacy, source_url=configured_source_url(),
                   max_connections=bounded_integer('LIVEMITSCHRIFT_MAX_CONNECTIONS', 128, 60, 512),
                   max_readers=bounded_integer('LIVEMITSCHRIFT_MAX_READERS', 96, 50, 480),
                   max_http=bounded_integer('LIVEMITSCHRIFT_MAX_HTTP', 32, 4, 128),
                   max_database_bytes=bounded_integer('LIVEMITSCHRIFT_MAX_DATABASE_BYTES', 4 * 1024**3, 1_048_576, 64 * 1024**3),
                   max_notebooks=bounded_integer('LIVEMITSCHRIFT_MAX_NOTEBOOKS', 128, 1, 1000),
                   max_notebooks_per_user=bounded_integer('LIVEMITSCHRIFT_MAX_NOTEBOOKS_PER_USER', 20, 1, 1000))

    @property
    def allowed_hosts(self) -> set[str]:
        hosts = {'localhost', '127.0.0.1', '::1'}
        if self.public_url:
            hosts.add(urlsplit(self.public_url).hostname)
        return hosts

    @property
    def cors_origins(self) -> tuple[str, ...]:
        return (*NATIVE_ORIGINS, self.public_url) if self.public_url else (*NATIVE_ORIGINS, 'http://127.0.0.1:1420', 'http://localhost:1420')


def configured_source_url() -> str:
    """An explicit source URL wins; otherwise point upstream at the revision baked into the image."""
    explicit = os.environ.get('LIVEMITSCHRIFT_SOURCE_URL') or None
    if explicit:
        url = urlsplit(explicit)
        if url.scheme != 'https' or not url.hostname or url.username or url.password or any(c in explicit for c in '"<>\' \n'):
            raise ValueError('LIVEMITSCHRIFT_SOURCE_URL must be an HTTPS URL.')
        return explicit
    revision = os.environ.get('LIVEMITSCHRIFT_SOURCE_REVISION') or None
    if revision is None:
        return UPSTREAM_SOURCE
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', revision):
        raise ValueError('LIVEMITSCHRIFT_SOURCE_REVISION must be a tag or commit name.')
    return f'{UPSTREAM_SOURCE}/tree/{revision}'


def server_directory() -> Path:
    return Path(os.environ.get('LIVEMITSCHRIFT_SERVER_DIR') or ROOT / '.livemitschrift-server-v1')
