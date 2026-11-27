"""Application factory. Importing this module never opens a database or a secret."""
from contextlib import asynccontextmanager
import fcntl
import os
from pathlib import Path
import re
import asyncio
from html import escape
import sqlite3

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi import HTTPException

from .access import PublisherAccess
from .accounts import Accounts
from .page_store import PageStore
from .paged import register_paged
from .security import PublicGuard
from .settings import Settings, server_directory

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / 'frontend'


def create_app(data_directory: Path | None = None, *, access: PublisherAccess | None = None, settings: Settings | None = None) -> FastAPI:
    config = settings or Settings.configured()
    directory = data_directory or server_directory()
    directory.mkdir(parents=True, exist_ok=True)
    credentials = access or PublisherAccess.configured(ROOT / 'backend/.env')
    store = PageStore(directory, max_bytes=config.max_database_bytes, max_notebooks=config.max_notebooks)
    accounts = Accounts(store)
    credentials.bind(accounts)

    @asynccontextmanager
    async def lifespan(app):
        with (directory / '.server.lock').open('a+b') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise RuntimeError('Only one backend process may use a data directory.') from error
            for stale in directory.glob('.incoming-*.sqlite3*'):
                stale.unlink(missing_ok=True)
            yield

    app = FastAPI(title='LiveMitschrift', version='0.2.0', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware('http')
    async def protect_writes(request: Request, call_next):
        if request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            try:
                # Routes read the authenticated account for ownership checks.
                request.state.publisher = credentials.authorize_upload(request)
            except HTTPException as error:
                return JSONResponse({'detail': error.detail}, status_code=error.status_code, headers={'Cache-Control': 'no-store'})
        return await call_next(request)

    app.add_middleware(CORSMiddleware, allow_origins=list(config.cors_origins), allow_methods=['GET', 'POST', 'DELETE'], allow_headers=['Authorization', 'Content-Type', 'X-LiveMitschrift-Publisher-Key'])
    html = (FRONTEND / 'notebook.html').read_text()
    landing = (FRONTEND / 'index.html').read_text()
    import_map = re.search(r'<script type="importmap">(.*?)</script>', html).group(1)
    app.add_middleware(PublicGuard, settings=config, import_map=import_map)
    register_paged(app, store, credentials, accounts, config.max_notebooks_per_user)

    @app.exception_handler(sqlite3.Error)
    async def storage_unavailable(request: Request, error: sqlite3.Error):
        return JSONResponse({'detail': 'Storage unavailable; retry later.'}, status_code=503)

    @app.get('/health')
    async def health() -> dict[str, str]:
        return {'status': 'ok'}

    @app.get('/robots.txt')
    async def robots():
        return PlainTextResponse('User-agent: *\nDisallow: /\n', headers={'Cache-Control': 'no-cache'})

    # An operator-edited HTML fragment (e.g. a mounted /config/datenschutz.html)
    # is served at /datenschutz; an explicit external URL takes precedence.
    privacy_file = Path(os.environ['LIVEMITSCHRIFT_PRIVACY_FILE']) if os.environ.get('LIVEMITSCHRIFT_PRIVACY_FILE') else None

    def privacy_fragment() -> str | None:
        if privacy_file is None or not privacy_file.is_file():
            return None
        with privacy_file.open('rb') as handle:
            data = handle.read(200_001)
        if len(data) > 200_000:
            raise HTTPException(500, 'Privacy notice is too large.')
        return data.decode('utf-8')

    def privacy_link() -> str:
        return config.privacy_url or ('/datenschutz' if privacy_file is not None and privacy_file.is_file() else '')

    @app.get('/datenschutz')
    async def privacy():
        fragment = await asyncio.to_thread(privacy_fragment)
        if fragment is None:
            raise HTTPException(404, 'No privacy notice configured.')
        page = ('<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<meta name="robots" content="noindex, nofollow, noarchive"><title>Datenschutz · LiveMitschrift</title>'
                '<link rel="stylesheet" href="/ui/style.css"></head><body class="document-page"><main class="landing privacy-notice">'
                f'{fragment}</main></body></html>')
        return HTMLResponse(page, headers={'Cache-Control': 'no-cache'})

    @app.get('/')
    async def index():
        link = escape(privacy_link(), quote=True)
        source = escape(config.source_url, quote=True)
        links = (f'<a href="{link}">Datenschutz</a> · ' if link else '') + f'<a href="{source}">Quellcode</a>'
        page = landing.replace('__PRIVACY_LINK__', f'<p class="landing-links">{links}</p>')
        return HTMLResponse(page, headers={'Cache-Control': 'no-store'})

    @app.get('/notebook/{identity}')
    async def notebook(identity: str):
        if not re.fullmatch(r'[a-f0-9]{64}', identity) or (await asyncio.to_thread(store.status, identity)) is None:
            raise HTTPException(404, 'Unknown notebook.')
        # The identity is validated hex; it only fills the per-notebook manifest link.
        page = html.replace('__NOTEBOOK__', identity).replace('__PRIVACY_URL__', escape(privacy_link(), quote=True)).replace('__SOURCE_URL__', escape(config.source_url, quote=True))
        return HTMLResponse(page, headers={'Cache-Control': 'no-store'})

    @app.get('/manifest/{identity}.webmanifest')
    async def manifest(identity: str):
        """Home-screen web app for one notebook: opens it without browser chrome."""
        state = await asyncio.to_thread(store.structure, identity) if re.fullmatch(r'[a-f0-9]{64}', identity) else None
        if state is None:
            raise HTTPException(404, 'Unknown notebook.')
        title = state['notebook']['title']
        return JSONResponse({
            'name': f'{title} · LiveMitschrift', 'short_name': title[:30], 'lang': 'de',
            'start_url': f'/notebook/{identity}', 'scope': f'/notebook/{identity}', 'id': f'/notebook/{identity}',
            'display': 'standalone', 'display_override': ['fullscreen', 'standalone'], 'orientation': 'any',
            'background_color': '#f0f3f1', 'theme_color': '#ffffff',
            'icons': [{'src': '/icons/icon-180.png', 'sizes': '180x180', 'type': 'image/png'},
                      {'src': '/icons/icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'}],
        }, media_type='application/manifest+json', headers={'Cache-Control': 'no-store'})

    for url, path in (('/icons', FRONTEND / 'icons'), ('/build', FRONTEND / 'dist'), ('/core', ROOT / 'packages/core/dist'), ('/pdfjs', ROOT / 'packages/pdf/dist/vendor'), ('/pdf', ROOT / 'packages/pdf/dist'), ('/ui', ROOT / 'packages/ui/dist')):
        app.mount(url, StaticFiles(directory=path, check_dir=False))
    return app
