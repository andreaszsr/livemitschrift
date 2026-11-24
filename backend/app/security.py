"""ASGI guards also cover WebSockets, before application allocation/parsing."""
import base64
import asyncio
from collections import OrderedDict
import hashlib
import ipaddress
import time
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

from .settings import Settings


STATIC_PREFIXES = ('/icons/', '/build/', '/core/', '/pdfjs/', '/pdf/', '/ui/')


class Bucket:
    def __init__(self, rate: float, capacity: int):
        self.rate, self.capacity = rate, capacity
        self.tokens: float = capacity
        self.updated = time.monotonic()

    def allow(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


class PublicGuard:
    def __init__(self, app, settings: Settings, import_map: str):
        self.app, self.settings = app, settings
        self.connections = self.readers = self.http_active = 0
        self.peers: OrderedDict[str, tuple[Bucket, Bucket]] = OrderedDict()
        self.global_http = Bucket(500, 3000)
        self.http_slots = asyncio.Semaphore(settings.max_http)
        digest = base64.b64encode(hashlib.sha256(import_map.encode()).digest()).decode()
        self.headers = {
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
            'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            # Notebook links are read capabilities: keep every response out of search engines.
            'x-robots-tag': 'noindex, nofollow, noarchive',
            'content-security-policy': f"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-{digest}'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' blob: data:; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        }
        if settings.public_url:
            self.headers['strict-transport-security'] = 'max-age=31536000'

    async def reject(self, scope, receive, send, status: int) -> None:
        if scope['type'] == 'websocket':
            await send({'type': 'websocket.close', 'code': 1013 if status in (429, 503) else 1008})
        else:
            await JSONResponse({'detail': 'Request unavailable.'}, status_code=status,
                               headers={'Cache-Control': 'no-store', 'Retry-After': '5'})(scope, receive, send)

    async def __call__(self, scope, receive, send):
        kind = scope['type']
        if kind not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return
        headers = {key.decode('latin1').lower(): value.decode('latin1') for key, value in scope['headers']}
        try:
            authority = urlsplit('//' + headers.get('host', ''))
            host, port = authority.hostname, authority.port
            if authority.username is not None or authority.password is not None or authority.path or authority.query or authority.fragment:
                raise ValueError('Invalid authority.')
        except ValueError:
            await self.reject(scope, receive, send, 400)
            return
        if sum(key.lower() == b'host' for key, _ in scope['headers']) != 1:
            await self.reject(scope, receive, send, 400)
            return
        if host not in self.settings.allowed_hosts:
            await self.reject(scope, receive, send, 400)
            return
        origin = headers.get('origin')
        canonical_host = ('[' + host + ']' if ':' in host else host) + (':' + str(port) if port else '')
        own_origin = ('https' if scope['scheme'] in ('https', 'wss') else 'http') + '://' + canonical_host
        if origin and origin not in (*self.settings.cors_origins, own_origin):
            await self.reject(scope, receive, send, 403)
            return
        if self.settings.public_url and scope['scheme'] not in ('https', 'wss'):
            peer = scope.get('client', ('',))[0]
            try:
                health = scope['path'] == '/health' and ipaddress.ip_address(peer).is_loopback
            except ValueError:
                health = False
            if not health:
                await self.reject(scope, receive, send, 403)
                return
        peer = scope.get('client', ('unknown',))[0]
        buckets = self.peers.pop(peer, None) or (Bucket(200, 2000), Bucket(2, 150))
        self.peers[peer] = buckets
        while len(self.peers) > 1024:
            self.peers.popitem(last=False)
        is_reader = kind == 'websocket' and '/view/' in scope['path']
        if kind == 'websocket':
            if not buckets[1].allow() or self.connections >= self.settings.max_connections or (is_reader and self.readers >= self.settings.max_readers):
                await self.reject(scope, receive, send, 503)
                return
            self.connections += 1; self.readers += int(is_reader)
        else:
            if self.http_active >= 256 or not self.global_http.allow() or not buckets[0].allow():
                await self.reject(scope, receive, send, 429)
                return
            self.http_active += 1
        async def protected_send(message):
            if message['type'] == 'http.response.start':
                original = {key.decode('latin1').lower(): value.decode('latin1') for key, value in message.get('headers', [])}
                original.update(self.headers)
                websocket_origin = ('wss' if scope['scheme'] == 'https' else 'ws') + '://' + canonical_host
                original['content-security-policy'] = original['content-security-policy'].replace("connect-src 'self';", f"connect-src 'self' {websocket_origin};")
                # Static viewer modules (pdf.js alone is ~1.7 MB) revalidate via
                # ETag instead of downloading again on every visit; documents,
                # API data and errors stay uncached.
                static = scope['path'].startswith(STATIC_PREFIXES) and message.get('status', 200) in (200, 304)
                original.setdefault('cache-control', 'no-cache' if static else 'no-store')
                message['headers'] = [(key.encode('latin1'), value.encode('latin1')) for key, value in original.items()]
            await send(message)
        acquired = False
        try:
            if kind == 'http':
                try:
                    await asyncio.wait_for(self.http_slots.acquire(), 5)
                    acquired = True
                except TimeoutError:
                    await self.reject(scope, receive, send, 503)
                    return
            await self.app(scope, receive, protected_send)
        finally:
            if acquired:
                self.http_slots.release()
            if kind == 'websocket':
                self.connections -= 1; self.readers -= int(is_reader)
            else:
                self.http_active -= 1
