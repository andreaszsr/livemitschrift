"""Publishing keys protect every write: the operator key (built-in admin) or a
personal key per lecturer. Readers remain anonymous."""
import asyncio
import hashlib
import hmac
import ipaddress
import json
import os
import re
from collections import OrderedDict
from pathlib import Path

from dotenv import dotenv_values
from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect

from .accounts import Accounts, Publisher
from .security import Bucket

KEY_PATTERN = re.compile(r"^[a-f0-9]{64}$")
KEY_HEADER = "X-LiveMitschrift-Publisher-Key"


def loopback_connection(connection: Request | WebSocket) -> bool:
    """Host alone is attacker-controlled: require a literal local host and peer."""
    if connection.url.hostname not in {"localhost", "127.0.0.1", "::1"} or not connection.client:
        return False
    try:
        return ipaddress.ip_address(connection.client.host).is_loopback
    except ValueError:
        return False


class PublisherAccess:
    def __init__(self, key: str | None):
        if key is not None and not KEY_PATTERN.fullmatch(key):
            raise ValueError("LIVEMITSCHRIFT_PUBLISHER_KEY must be 64 lowercase hexadecimal characters.")
        self.digest = hashlib.sha256(key.encode("ascii")).digest() if key else None
        self.accounts: Accounts | None = None
        # Failed attempts per client address: 10 at once, then one every 5 s.
        self.failures: OrderedDict[str, Bucket] = OrderedDict()

    def bind(self, accounts: Accounts) -> None:
        self.accounts = accounts
        if self.digest is not None:
            accounts.ensure_builtin_admin()

    def enabled(self) -> bool:
        return self.digest is not None or (self.accounts is not None and self.accounts.has_active_tokens())

    def _failed(self, connection: Request | WebSocket) -> None:
        peer = connection.client.host if connection.client else "unknown"
        bucket = self.failures.pop(peer, None) or Bucket(0.2, 10)
        self.failures[peer] = bucket
        while len(self.failures) > 1024:
            self.failures.popitem(last=False)
        if not bucket.allow():
            raise HTTPException(429, "Too many failed publisher authentications; retry later.")

    @classmethod
    def configured(cls, env_file: Path) -> "PublisherAccess":
        # Parse exactly this file, never search parent directories. Existing
        # environment values take precedence, including an explicitly empty key.
        filename = os.environ.get("LIVEMITSCHRIFT_PUBLISHER_KEY_FILE")
        if filename:
            if "LIVEMITSCHRIFT_PUBLISHER_KEY" in os.environ:
                raise ValueError("Configure either a key file or an environment key, not both.")
            try:
                with Path(filename).open('rb') as handle:
                    data = handle.read(129)
                if len(data) > 128:
                    raise ValueError("Invalid publisher secret file.")
                return cls(data.decode("ascii").strip())
            except (OSError, UnicodeError) as error:
                raise ValueError("Cannot read publisher secret file.") from error
        if "LIVEMITSCHRIFT_PUBLISHER_KEY" in os.environ:
            return cls(os.environ["LIVEMITSCHRIFT_PUBLISHER_KEY"] or None)
        values = dotenv_values(env_file, interpolate=False) if env_file.is_file() else {}
        return cls(values.get("LIVEMITSCHRIFT_PUBLISHER_KEY") or None)

    def verify(self, connection: Request | WebSocket, key: object) -> Publisher:
        if not self.enabled():
            raise HTTPException(503, "Publishing is disabled: configure the server publisher key.")
        if connection.url.scheme not in {"https", "wss"} and not loopback_connection(connection):
            raise HTTPException(403, "Publishing requires HTTPS/WSS; plain HTTP is local-only.")
        if isinstance(key, str) and KEY_PATTERN.fullmatch(key):
            if self.digest is not None and hmac.compare_digest(self.digest, hashlib.sha256(key.encode("ascii")).digest()):
                return self.accounts.builtin_admin() if self.accounts else Publisher(0, "admin", "admin", None)
            publisher = self.accounts.resolve(key) if self.accounts else None
            if publisher is not None:
                return publisher
        self._failed(connection)
        raise HTTPException(401, "A valid server publisher key is required.")

    def authorize_upload(self, request: Request) -> Publisher:
        return self.verify(request, request.headers.get(KEY_HEADER))

    async def authenticate(self, websocket: WebSocket) -> Publisher | None:
        """Authenticate a tiny first frame before parsing any notebook or ink."""
        try:
            # Fail closed before accepting credentials over an insecure transport.
            if not self.enabled():
                raise HTTPException(503, "Server publishing is disabled.")
            if websocket.url.scheme != "wss" and not loopback_connection(websocket):
                raise HTTPException(403, "Publishing requires HTTPS/WSS.")
            frame = await asyncio.wait_for(websocket.receive(), timeout=5)
            if frame["type"] == "websocket.disconnect":
                return False
            text = frame.get("text")
            if not isinstance(text, str) or len(text.encode("utf-8")) > 256:
                raise ValueError("Invalid authentication frame.")
            message = json.loads(text)
            if not isinstance(message, dict) or set(message) != {"type", "key"} or message["type"] != "authenticate":
                raise ValueError("Authentication must precede publication.")
            publisher = self.verify(websocket, message["key"])
            await websocket.send_json({"type": "authenticated"})
            return publisher
        except HTTPException as error:
            code = {503: 4503, 403: 4426, 429: 4429}.get(error.status_code, 4401)
            await websocket.close(code=code, reason=error.detail)
        except (ValueError, TimeoutError):
            await websocket.close(code=4401, reason="Server authentication required.")
        except WebSocketDisconnect:
            pass
        return None
