"""Validated deployment settings; defaults bind the application to local use."""
from dataclasses import dataclass
import os
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
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
        return cls(public_url=public, privacy_url=privacy,
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


def server_directory() -> Path:
    return Path(os.environ.get('LIVEMITSCHRIFT_SERVER_DIR') or ROOT / '.livemitschrift-server-v1')
