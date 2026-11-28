"""Revision negotiation and selected-page subscriptions for the normal application."""
import asyncio
import hashlib
import io
import json
import re
import sqlite3
import secrets
from collections import OrderedDict
from fastapi import Request
from fastapi.responses import Response
from .security import Bucket
from contextlib import suppress
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from pypdf import PdfReader, PdfWriter

from .protocol import text_message, SESSION_PATTERN, MAX_PDF_BYTES, MAX_NOTEBOOK_ASSET_BYTES, MAX_IMAGE_BYTES
from .images import valid_image
from .notebook import NotebookRoom, Snapshot, Page, Stroke, EditEvent, event_adapter, Viewport, Pointer
from .page_store import Recovery, QuotaExceeded, MAX_FRAME_BYTES, MAX_TRANSFER_BYTES, CHUNK_CHARACTERS, MAX_PAGE_BYTES
from .room import Client, ProtocolError, Room
from .access import PublisherAccess
from .accounts import Accounts, Publisher
from .page_store import PageStore, encoded


class NotOwner(ProtocolError):
    """The notebook belongs to another publishing account."""


class KeyRevoked(ProtocolError):
    """The personal key was revoked or its account disabled during the session."""


class ReaderRateLimited(Exception):
    """A reader exceeded its request budget; it may reconnect after a pause."""


async def durable_io(function: Callable[..., Any], *args: Any) -> Any:
    """Finish a SQLite operation before releasing its lease or staging database."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # A disconnect may cancel the socket task while its worker still commits.
        # Wait for that worker so a retry observes either the old state or its ACK.
        await task
        raise


class Transfers:
    """One bounded JSON value at a time, carried by small WebSocket frames."""
    def __init__(self) -> None:
        self.parts = None
        self.size = 0

    def receive(self, value: dict[str, Any]) -> dict[str, Any] | None:
        kind = value.get("type")
        if kind == "transfer_start":
            if self.parts is not None:
                raise ProtocolError("Nested transfer.")
            self.parts, self.size = [], 0
        elif kind == "transfer_chunk":
            if self.parts is None or not isinstance(value.get("text"), str) or not value["text"] or len(value["text"]) > CHUNK_CHARACTERS or len(self.parts) >= 4096:
                raise ProtocolError("Unexpected transfer chunk.")
            self.size += len(value["text"].encode())
            if self.size > MAX_TRANSFER_BYTES:
                raise ProtocolError("Transfer exceeds its page/operation limit.")
            self.parts.append(value["text"])
        elif kind == "transfer_end":
            if self.parts is None:
                raise ProtocolError("Unexpected transfer end.")
            result = json.loads("".join(self.parts))
            self.parts = None
            return result
        elif kind == "ping":
            return value
        elif self.parts is not None:
            raise ProtocolError("Interrupted transfer.")
        else:
            return value
        return None


def prepare_value(value: dict[str, Any]) -> tuple[str, ...]:
    """Immutable frames can be shared by subscribers to the same page revision."""
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if len(payload.encode()) > MAX_TRANSFER_BYTES:
        raise ProtocolError("Page/operation transfer limit reached.")
    if len(payload) <= CHUNK_CHARACTERS:
        return (payload,)
    chunks = (json.dumps({"type": "transfer_chunk", "text": payload[offset:offset + CHUNK_CHARACTERS]}, separators=(",", ":"), ensure_ascii=False) for offset in range(0, len(payload), CHUNK_CHARACTERS))
    return ('{"type":"transfer_start"}', *chunks, '{"type":"transfer_end"}')


async def send_value(socket: WebSocket, value: dict[str, Any] | tuple[str, ...]) -> None:
    for frame in value if isinstance(value, tuple) else prepare_value(value):
        await socket.send_text(frame)


class PageFrames:
    """One process-wide budget; notebook count must not multiply cached ink."""
    def __init__(self) -> None:
        self.values: OrderedDict[tuple[str, str, str], tuple[str, ...]] = OrderedDict()
        self.size = 0

    def get(self, key: tuple[str, str, str]) -> tuple[str, ...] | None:
        value = self.values.get(key)
        if value is not None:
            self.values.move_to_end(key)
        return value

    def put(self, key: tuple[str, str, str], frames: tuple[str, ...]) -> None:
        self.values[key] = frames
        self.size += sum(len(frame.encode()) for frame in frames)
        # A single large page can still be reused by all simultaneous readers.
        while len(self.values) > 1 and (len(self.values) > 16 or self.size > 16_000_000):
            _, old = self.values.popitem(last=False)
            self.size -= sum(len(frame.encode()) for frame in old)


class PagedRoom(NotebookRoom):
    def __init__(self, frames: PageFrames) -> None:
        super().__init__()
        self.frames = frames
        self.cache_identity = secrets.token_hex(16)
        self.selected: dict[Client, tuple[str, int]] = {}
        self.loaded_page: str | None = None
        self.revision = 0
        self.epoch = secrets.token_hex(16)
        self.lock = asyncio.Lock()
        self.durable_revisions: dict[str, str] = {}

    def broadcast(self, value: dict[str, Any], source: Client | None = None) -> None:
        page_id = None if value.get("type") == "extent" else value.get("pageId") or value.get("edit", {}).get("pageId")
        for client in self.clients:
            if client is not source and client.role == "student" and (page_id is None or self.selected.get(client, (None,))[0] == page_id):
                self.enqueue(client, value)

    def cache_page(self, key: tuple[str, str], page: dict[str, Any]) -> tuple[str, ...]:
        payload = json.dumps(page, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        if len(payload.encode()) > MAX_PAGE_BYTES:
            raise ProtocolError("Page transfer limit reached.")
        frames = tuple(json.dumps({"type":"transfer_chunk", "text":payload[start:start+CHUNK_CHARACTERS]}, separators=(",", ":"), ensure_ascii=False) for start in range(0, len(payload), CHUNK_CHARACTERS))
        self.frames.put((self.cache_identity, *key), frames)
        return frames

    @staticmethod
    def page_message(frames: tuple[str, ...], revision: str, request: int) -> tuple[str, ...]:
        prefix = '{"type":"page","request":' + str(request) + ',"revision":' + json.dumps(revision) + ',"page":'
        return ('{"type":"transfer_start"}', json.dumps({"type":"transfer_chunk","text":prefix}, separators=(",", ":")), *frames,
                '{"type":"transfer_chunk","text":"}"}', '{"type":"transfer_end"}')

    def live_revision(self) -> str:
        return f"preview-{self.epoch}-{self.revision}"

    def structure_message(self, state: dict[str, Any]) -> dict[str, Any]:
        return {"type": "structure", "notebook": state["notebook"], "position": state["position"]}

    def reset(self, state: dict[str, Any]) -> None:
        self.cache_identity = secrets.token_hex(16)
        self.durable_revisions = {p["id"]: p["revision"] for t in state["notebook"]["topics"] for p in t["pages"]}
        clean = json.loads(json.dumps(state))
        for topic in clean["notebook"]["topics"]:
            for page in topic["pages"]:
                page.pop("revision", None)
        self.state = Snapshot.model_validate(clean)
        self.pages = {p.id: p for t in self.state.notebook.topics for p in t.pages}
        self.loaded_page, self.active, self.point_count = None, None, 0
        self.revision += 1
        self.edits.clear()

    async def load_page(self, store: PageStore, identity: str, page_id: str) -> None:
        if page_id not in self.pages:
            raise ProtocolError("Unknown page.")
        if self.loaded_page == page_id:
            return
        if self.active:
            raise ProtocolError("Finish the active page before changing it.")
        if self.loaded_page:
            self.pages[self.loaded_page].strokes = []
        page, _ = await asyncio.to_thread(store.page, identity, page_id)
        target = self.pages[page_id]
        loaded = Page.model_validate(page)
        target.strokes, target.images = loaded.strokes, loaded.images
        target.height, target.next_order = page["height"], page["nextOrder"]
        self.point_count = sum(len(s.points) for s in target.strokes)
        self.loaded_page = page_id

    def disconnect(self, client: Client) -> None:
        self.clients.discard(client)
        self.selected.pop(client, None)
        if client is self.instructor:
            self.instructor = None
            self.broadcast({"type": "source_status", "connected": False})


def register_paged(app: FastAPI, store: PageStore, access: PublisherAccess, accounts: Accounts, max_owned: int = 20) -> None:
    rooms: dict[str, PagedRoom] = {}
    frames = PageFrames()
    # Large PDFs are parsed in memory; two extractions bound peak memory.
    pdf_slots = asyncio.Semaphore(2)
    export_slots = asyncio.Semaphore(2)

    class PageExportResponse(Response):
        async def __call__(self, scope, receive, send) -> None:
            try:
                # A deliberately slow reader must not hold an export slot forever.
                await asyncio.wait_for(super().__call__(scope, receive, send), 60)
            except TimeoutError:
                pass
            finally:
                # Keep the memory slot until the body is sent, including on a
                # disconnected reader. A slow download must not multiply pages.
                export_slots.release()

    def room_for(identity: str) -> PagedRoom:
        if identity not in rooms:
            if len(rooms) >= 32:
                idle = next((key for key, room in rooms.items() if not room.clients), None)
                if idle is None:
                    raise ProtocolError("Notebook session limit reached.")
                del rooms[idle]
            rooms[identity] = PagedRoom(frames)
        return rooms[identity]

    async def serve(socket: WebSocket, room: PagedRoom, client: Client, handler: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        transfers = Transfers()
        messages = Bucket(30, 120)
        # Follow mode subscribes once per instructor page change; allow brisk
        # slide flipping while still bounding abusive readers.
        subscriptions = Bucket(10, 40)
        async def receive() -> None:
            while True:
                raw = json.loads(await asyncio.wait_for(text_message(socket, MAX_FRAME_BYTES if client.role == "instructor" else 4096), 30))
                if not isinstance(raw, dict) or (client.role == "student" and raw.get("type") not in ("subscribe", "ping")):
                    raise ProtocolError("Read-only page subscription required.")
                if client.role == "student" and (not messages.allow() or (raw.get("type") == "subscribe" and not subscriptions.allow())):
                    raise ReaderRateLimited()
                value = transfers.receive(raw)
                if value is None:
                    continue
                if not isinstance(value, dict):
                    raise ProtocolError("Expected a protocol object.")
                if value.get("type") == "ping":
                    Room.enqueue(client, {"type": "pong"})
                else:
                    async with room.lock:
                        await handler(value)
        async def send() -> None:
            while True:
                await asyncio.wait_for(send_value(socket, await client.outgoing.get()), 30)
        tasks = [asyncio.create_task(receive()), asyncio.create_task(send()), asyncio.create_task(client.overflow.wait())]
        code, reason = 1000, ""
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if client.overflow.is_set():
                code, reason = 1013, "Reconnect to refresh the selected page."
        except ReaderRateLimited:
            # 1013 (try again later) lets the viewer reconnect with backoff.
            code, reason = 1013, "Reader request rate exceeded; reconnect shortly."
        except KeyRevoked:
            code, reason = 4401, "Publisher key revoked."
        except QuotaExceeded:
            code, reason = 4413, "Personal notebook quota reached."
        except (ValueError, ValidationError, KeyError, TypeError, RecursionError):
            code, reason = 1008, "Invalid synchronization operation."
        except (OSError, sqlite3.Error):
            code, reason = 1011, "Server storage unavailable; retry local changes."
        except (WebSocketDisconnect, TimeoutError):
            pass
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with suppress(asyncio.CancelledError, WebSocketDisconnect, OSError, ValueError, RuntimeError, sqlite3.Error, TimeoutError, ReaderRateLimited):
                    await task
            async with room.lock:
                was_writer = client is room.instructor
                room.disconnect(client)
                if was_writer:
                    state = await asyncio.to_thread(store.structure, identity_for(room))
                    if state:
                        room.reset(state)
                        room.broadcast(room.structure_message(state))
            with suppress(WebSocketDisconnect, RuntimeError, OSError):
                await socket.close(code=code, reason=reason)

    def identity_for(room: PagedRoom) -> str:
        return next(key for key, value in rooms.items() if value is room)

    async def receive_asset(asset_id: str, request: Request, limit: int, label: str) -> tuple[str, bytes]:
        """Authorize an asset upload for the caller's notebook and read it within `limit` bytes."""
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer ") or not re.fullmatch(SESSION_PATTERN, authorization[7:]):
            raise HTTPException(403, "Notebook publishing capability required.")
        if not re.fullmatch(SESSION_PATTERN, asset_id):
            raise HTTPException(400, f"Invalid {label} identity.")
        identity = hashlib.sha256(authorization[7:].encode("ascii")).hexdigest()
        if await asyncio.to_thread(store.is_withdrawn, identity):
            raise HTTPException(410, "Notebook was withdrawn.")
        owner = await asyncio.to_thread(store.owner, identity)
        if owner is not None and owner != request.state.publisher.user_id:
            raise HTTPException(403, "Notebook belongs to another account.")
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > limit:
                raise HTTPException(413, f"{label} exceeds {limit // 1_000_000} MB.")
            data.extend(chunk)
        if hashlib.sha256(data).hexdigest() != asset_id:
            raise HTTPException(400, f"{label} identity mismatch.")
        return identity, bytes(data)

    @app.post("/api/sync/pdf/{asset_id}")
    async def upload(asset_id: str, request: Request) -> dict[str, str]:
        identity, data = await receive_asset(asset_id, request, MAX_PDF_BYTES, "PDF")
        if not data.startswith(b"%PDF-"):
            raise HTTPException(400, "PDF identity mismatch.")
        try:
            await durable_io(store.put_asset, identity, asset_id, data)
        except ProtocolError as error:
            raise HTTPException(413, str(error)) from error
        return {"sessionId": identity}

    @app.post("/api/sync/image/{asset_id}")
    async def upload_image(asset_id: str, request: Request) -> dict[str, str]:
        identity, data = await receive_asset(asset_id, request, MAX_IMAGE_BYTES, "Image")
        if valid_image(data) is None:
            raise HTTPException(400, "Expected a PNG or JPEG image of at most 4096 pixels per side.")
        try:
            await durable_io(store.put_asset, identity, asset_id, data, "image")
        except ProtocolError as error:
            raise HTTPException(413, str(error)) from error
        return {"sessionId": identity}

    @app.delete("/api/notebook/{identity}")
    async def withdraw(identity: str, request: Request) -> Response:
        if not re.fullmatch(SESSION_PATTERN, identity):
            raise HTTPException(404, "Unknown notebook.")
        # Owners withdraw their own notebooks; administrators may withdraw any identity.
        publisher: Publisher = request.state.publisher
        if not publisher.admin:
            if await asyncio.to_thread(store.status, identity) is None:
                raise HTTPException(404, "Unknown notebook.")
            if await asyncio.to_thread(store.owner, identity) not in (None, publisher.user_id):
                raise HTTPException(403, "Notebook belongs to another account.")
        room = rooms.get(identity)
        lock = room.lock if room else asyncio.Lock()
        async with lock:
            await durable_io(store.withdraw, identity)
            if room:
                for client in room.clients:
                    client.overflow.set()
        return Response(status_code=204)

    @app.websocket("/ws/sync/v2/publish")
    async def publish(socket: WebSocket) -> None:
        await socket.accept()
        publisher = await access.authenticate(socket)
        if publisher is None:
            return
        stage = None
        room = client = None
        try:
            hello = json.loads(await asyncio.wait_for(text_message(socket, 4096), 15))
            if not isinstance(hello, dict) or hello.get("type") != "hello" or not re.fullmatch(SESSION_PATTERN, hello.get("secret", "")):
                raise ProtocolError("Invalid writer hello.")
            local_sequence, local_head = hello["sequence"], hello["head"]
            if type(local_sequence) is not int or not 0 <= local_sequence <= 9_007_199_254_740_991 or not re.fullmatch(SESSION_PATTERN, local_head):
                raise ProtocolError("Invalid local revision.")
            identity = hashlib.sha256(hello["secret"].encode("ascii")).hexdigest()
            if await asyncio.to_thread(store.is_withdrawn, identity):
                raise ProtocolError("Notebook was withdrawn.")
            owner = await asyncio.to_thread(store.owner, identity)
            if owner is not None and owner != publisher.user_id:
                raise NotOwner("Notebook belongs to another account.")
            if owner is None and await asyncio.to_thread(store.status, identity) is not None:
                await asyncio.to_thread(store.claim, identity, publisher.user_id)
            room = room_for(identity)
            async with room.lock:
                status = await asyncio.to_thread(store.status, identity)
                if status and (status["sequence"] > local_sequence or (status["sequence"] == local_sequence and status["head"] not in (None, local_head))):
                    raise ProtocolError("Server revision conflicts with local data.")
                # An old publisher must never commit after a new lease is issued.
                if room.instructor:
                    room.instructor.overflow.set()
                    room.clients.discard(room.instructor)
                client = Client("instructor")
                room.instructor = client
                room.clients.add(client)
                first = hello.get("firstPending")
                recover = hello.get("forceRecovery") is True or not status or status["head"] is None or (status["sequence"] < local_sequence and (type(first) is not int or first > status["sequence"] + 1))
                state = await asyncio.to_thread(store.structure, identity)
                if state:
                    room.reset(state)
                    room.broadcast(room.structure_message(state))
                Room.enqueue(client, {"type": "resume", "sequence": status["sequence"] if status else 0, "recover": recover, "sessionId": identity, "assets": await asyncio.to_thread(store.assets, identity)})
                room.broadcast({"type": "source_status", "connected": True})
            manifest = None

            async def operation(value: dict[str, Any]) -> None:
                nonlocal stage, manifest, recover
                if room.instructor is not client:
                    raise ProtocolError("Publisher lease replaced.")
                kind = value.get("type")
                # Durable writes re-check the personal key so revocation takes effect.
                if kind in ("recover_begin", "commit") and not await asyncio.to_thread(accounts.still_valid, publisher):
                    raise KeyRevoked()
                if kind == "recover_begin":
                    if stage is not None:
                        raise ProtocolError("Recovery already started.")
                    manifest = value
                    if type(value.get("sequence")) is not int or not local_sequence <= value["sequence"] <= 9_007_199_254_740_991 or not re.fullmatch(SESSION_PATTERN, value.get("head", "")):
                        raise ProtocolError("Invalid recovery revision.")
                    parsed = Snapshot.model_validate(value["snapshot"])
                    if any(page.strokes for topic in parsed.notebook.topics for page in topic.pages):
                        raise ProtocolError("Recovery manifest must contain metadata only.")
                    stage = Recovery(store.path.parent, store.max_bytes)
                elif kind == "recover_page":
                    if stage is None:
                        raise ProtocolError("Recovery not started.")
                    allowed = {page["id"] for topic in manifest["snapshot"]["notebook"]["topics"] for page in topic["pages"]}
                    if value["page"]["id"] not in allowed:
                        raise ProtocolError("Page is outside the recovery manifest.")
                    await durable_io(stage.put, value["page"])
                    Room.enqueue(client, {"type": "page_staged", "pageId": value["page"]["id"]})
                elif kind == "recover_end":
                    if stage is None or manifest is None:
                        raise ProtocolError("Recovery not started.")
                    await durable_io(store.recover, identity, manifest["sequence"], manifest["head"], manifest["snapshot"], stage, publisher.user_id, None if publisher.admin else max_owned)
                    stage.close()
                    stage = None
                    recover = False
                    state = await asyncio.to_thread(store.structure, identity)
                    room.reset(state)
                    room.broadcast(room.structure_message(state))
                    Room.enqueue(client, {"type": "ack", "sequence": manifest["sequence"]})
                elif kind == "commit":
                    if recover or stage is not None or type(value.get("sequence")) is not int or not re.fullmatch(SESSION_PATTERN, value.get("head", "")):
                        raise ProtocolError("Complete recovery before committing.")
                    changed = await durable_io(store.delta, identity, value["sequence"], value["head"], value["change"])
                    if changed:
                        room.revision += 1
                        change = value["change"]
                        if change["type"] == "structure":
                            state = await asyncio.to_thread(store.structure, identity)
                            previous_position = room.state.position if room.state else None
                            room.reset(state)
                            if previous_position and previous_position.page_id in room.pages:
                                room.state.position = previous_position
                                state["position"] = previous_position.model_dump(by_alias=True)
                            room.broadcast(room.structure_message(state))
                        else:
                            edit = EditEvent.model_validate(change).edit
                            room.durable_revisions[edit.page_id] = value["head"]
                            room.pages[edit.page_id].height = max(room.pages[edit.page_id].height, edit.height)
                            room.broadcast({"type": "extent", "pageId": edit.page_id, "height": edit.height})
                            if room.loaded_page == edit.page_id:
                                # Apply to the live preview too, replacing matching
                                # preview identities without changing other pending ink.
                                live = edit.model_copy(deep=True)
                                live.id = f"durable-{value['sequence']}"
                                live.remove = list(dict.fromkeys(live.remove + [s.id for s in live.insert]))
                                live.remove_images = list(dict.fromkeys(live.remove_images + [i.id for i in live.insert_images]))
                                if room.active and room.active[1] in live.remove:
                                    room.active = None
                                room.apply(client, EditEvent(type="edit", edit=live))
                            else:
                                room.broadcast(change, source=client)
                            room.broadcast({"type": "revision", "pageId": edit.page_id, "revision": room.live_revision() if room.loaded_page == edit.page_id else value["head"]}, source=client)
                        Room.enqueue(client, {"type": "ack", "sequence": value["sequence"]})
                elif kind == "resume_ink":
                    if recover or stage is not None:
                        raise ProtocolError("Finish recovery first.")
                    page_id = value["pageId"]
                    await room.load_page(store, identity, page_id)
                    stroke = Stroke.model_validate(value["stroke"])
                    page = room.pages[page_id]
                    if room.active == (page_id, stroke.id):
                        previous = next(s for s in page.strokes if s.id == stroke.id)
                        page.strokes.remove(previous)
                        room.point_count -= len(previous.points)
                    if stroke.complete or any(s.id == stroke.id or s.order == stroke.order for s in page.strokes) or any(p.y > page.height for p in stroke.points):
                        raise ProtocolError("Invalid resumed ink.")
                    page.strokes.append(stroke)
                    page.next_order = max(page.next_order, stroke.order + 1)
                    room.point_count += len(stroke.points)
                    room.active = (page_id, stroke.id)
                    room.revision += 1
                    for reader, (selected, request) in room.selected.items():
                        if selected == page_id:
                            Room.enqueue(reader, {"type": "page", "page": page.model_dump(by_alias=True), "revision": room.live_revision(), "request": request})
                else:
                    if recover or stage is not None:
                        raise ProtocolError("Finish recovery first.")
                    event = event_adapter.validate_python(value)
                    if not room.state:
                        raise ProtocolError("Notebook missing.")
                    if isinstance(event, Pointer):
                        # Transient laser pointer: never stored, never loads a page.
                        room.apply(client, event)
                        return
                    if not isinstance(event, Viewport):
                        page_id = event.edit.page_id if isinstance(event, EditEvent) else event.page_id
                        await room.load_page(store, identity, page_id)
                    if isinstance(event, EditEvent):
                        room.broadcast({"type": "extent", "pageId": event.edit.page_id, "height": event.edit.height})
                    room.apply(client, event)
                    room.revision += 1
                    if not isinstance(event, Viewport):
                        # A transient cache token cannot be confused with a durable
                        # token after a server restart or interrupted preview.
                        room.broadcast({"type": "revision", "pageId": page_id, "revision": room.live_revision()}, source=client)
            await serve(socket, room, client, operation)
        except NotOwner:
            with suppress(RuntimeError):
                await socket.close(code=4403, reason="Notebook belongs to another account.")
        except (ValueError, ValidationError, KeyError, TypeError, TimeoutError):
            with suppress(RuntimeError):
                await socket.close(code=1008, reason="Conflicting or invalid local synchronization state.")
        except (OSError, sqlite3.Error):
            with suppress(RuntimeError):
                await socket.close(code=1011, reason="Server storage unavailable.")
        except WebSocketDisconnect:
            pass
        finally:
            if stage:
                stage.close()
            if room and client and client in room.clients:
                room.disconnect(client)

    @app.websocket("/ws/notebook/v2/view/{identity}")
    async def view(socket: WebSocket, identity: str) -> None:
        await socket.accept()
        client = room = None
        try:
            if not re.fullmatch(SESSION_PATTERN, identity):
                raise ProtocolError("Unknown notebook.")
            state = await asyncio.to_thread(store.structure, identity)
            if state is None:
                raise ProtocolError("Unknown notebook.")
            room = room_for(identity)
            async with room.lock:
                if room.state is None:
                    room.reset(state)
                else:
                    state["position"] = room.state.position.model_dump(by_alias=True)
                client = Client("student")
                room.clients.add(client)
                Room.enqueue(client, room.structure_message(state))
                Room.enqueue(client, {"type": "source_status", "connected": room.instructor is not None})
            async def operation(value: dict[str, Any]) -> None:
                if value.get("type") != "subscribe" or type(value.get("request")) is not int:
                    raise ProtocolError("Read-only page subscription required.")
                page_id = value.get("pageId")
                if page_id not in room.pages:
                    raise ProtocolError("Unknown page.")
                room.selected[client] = (page_id, value["request"])
                revision = room.live_revision() if room.loaded_page == page_id else room.durable_revisions[page_id]
                if value.get("revision") == revision:
                    Room.enqueue(client, {"type": "page_current", "pageId": page_id, "revision": revision, "request": value["request"]})
                    return
                key = (page_id, revision)
                frames = room.frames.get((room.cache_identity, *key))
                if frames is None:
                    if room.loaded_page == page_id:
                        page = room.pages[page_id].model_dump(by_alias=True)
                    else:
                        page, _ = await asyncio.to_thread(store.page, identity, page_id)
                    frames = room.cache_page(key, page)
                Room.enqueue(client, room.page_message(frames, revision, value["request"]))
            await serve(socket, room, client, operation)
        except (ValueError, KeyError, TypeError):
            with suppress(RuntimeError):
                await socket.close(code=1008, reason="Unknown notebook or invalid subscription.")
        except WebSocketDisconnect:
            pass
        finally:
            if room and client:
                room.disconnect(client)

    def pdf_page(identity: str, asset_id: str, number: int) -> bytes:
        state = store.structure(identity)
        if not state or not any(p["background"] and p["background"]["assetId"] == asset_id and p["background"]["pageNumber"] == number for t in state["notebook"]["topics"] for p in t["pages"]):
            raise HTTPException(404, "PDF page unavailable.")
        with store.connect() as db:
            cached = db.execute("SELECT data FROM pdf_pages WHERE identity=? AND asset_id=? AND page_number=?", (identity, asset_id, number)).fetchone()
        if cached:
            return cached[0]
        data = store.asset(identity, asset_id)
        if data is None:
            raise HTTPException(404, "PDF resource unavailable.")
        try:
            reader = PdfReader(io.BytesIO(data))
            if number < 1 or number > len(reader.pages):
                raise ValueError("Unknown PDF page.")
            writer = PdfWriter()
            writer.append(reader, pages=[number - 1], import_outline=False)
            output = io.BytesIO()
            writer.write(output)
            result = output.getvalue()
        except Exception as error:
            raise HTTPException(422, "PDF page cannot be extracted.") from error
        with store.connect() as db:
            size = db.execute("SELECT COALESCE(sum(length(data)),0) FROM pdf_pages WHERE identity=?", (identity,)).fetchone()[0]
            if size + len(result) <= MAX_NOTEBOOK_ASSET_BYTES:
                db.execute("INSERT OR IGNORE INTO pdf_pages VALUES(?,?,?,?)", (identity, asset_id, number, result))
        return result

    @app.get("/api/notebook/{identity}/page/{page_id}/export")
    async def export_page(identity: str, page_id: str) -> Response:
        if not re.fullmatch(SESSION_PATTERN, identity) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', page_id):
            raise HTTPException(404, "Unknown page.")
        def read() -> bytes:
            try:
                page, _ = store.page(identity, page_id)
            except ProtocolError as error:
                raise HTTPException(404, "Unknown page.") from error
            data = encoded(page).encode('utf-8')
            if len(data) > MAX_PAGE_BYTES:
                raise HTTPException(413, "Page export limit reached.")
            return data
        # Bound large reads off the event loop. Cancellation must finish its
        # worker before another export takes the memory slot. Waiting is short:
        # a queued request also holds one of the guard's general HTTP slots.
        try:
            await asyncio.wait_for(export_slots.acquire(), 10)
        except TimeoutError:
            raise HTTPException(503, "Export busy; retry shortly.", headers={"Retry-After": "2"}) from None
        try:
            data = await durable_io(read)
            return PageExportResponse(data, media_type='application/json', headers={'Cache-Control': 'no-store'})
        except BaseException:
            export_slots.release()
            raise

    @app.get("/api/notebook/{identity}/page/{page_id}/preview")
    async def preview(identity: str, page_id: str) -> dict[str, Any]:
        if not re.fullmatch(SESSION_PATTERN, identity):
            raise HTTPException(404, "Unknown notebook.")
        def read() -> dict[str, Any]:
            with store.connect() as db:
                row = db.execute("SELECT metadata FROM pages WHERE identity=? AND page_id=?", (identity, page_id)).fetchone()
                if row:
                    page = json.loads(row[0])
                    strokes = (json.loads(r[0]) for r in db.execute("SELECT data FROM strokes WHERE identity=? AND page_id=? ORDER BY stroke_order LIMIT 128", (identity, page_id)))
                else:
                    raise HTTPException(404, "Unknown page.")
                limit = max(900, 1200 * page["background"]["height"] / page["background"]["width"]) if page["background"] else 1600
                remaining = 4096
                for stroke in strokes:
                    points = [p for p in stroke["points"] if p["y"] <= limit]
                    if not points:
                        continue
                    # Preview geometry is disposable and deliberately bounded.
                    step = max(1, (len(points) + min(remaining, 128) - 1) // min(remaining, 128))
                    stroke["points"] = points[::step][:remaining]
                    page["strokes"].append(stroke)
                    remaining -= len(stroke["points"])
                    if not remaining:
                        break
                return page
        return await asyncio.to_thread(read)

    def page_image(identity: str, asset_id: str) -> tuple[bytes, str]:
        # Only images that a page of this notebook currently shows are served.
        state = store.structure(identity)
        if not state or not any(i["assetId"] == asset_id for t in state["notebook"]["topics"] for p in t["pages"] for i in p.get("images", [])):
            raise HTTPException(404, "Image unavailable.")
        data = store.asset(identity, asset_id, "image")
        media_type = valid_image(data) if data is not None else None
        if media_type is None:
            raise HTTPException(404, "Image unavailable.")
        return data, media_type

    @app.get("/api/notebook/{identity}/image/{asset_id}")
    async def download_image(identity: str, asset_id: str) -> Response:
        if not re.fullmatch(SESSION_PATTERN, identity) or not re.fullmatch(SESSION_PATTERN, asset_id):
            raise HTTPException(404, "Unknown image.")
        data, media_type = await asyncio.to_thread(page_image, identity, asset_id)
        return Response(data, media_type=media_type, headers={"Cache-Control": "private, max-age=31536000, immutable", "ETag": f'"{asset_id}"', "X-Content-Type-Options": "nosniff"})

    @app.get("/api/notebook/{identity}/pdf/{asset_id}/page/{number}")
    async def download_page(identity: str, asset_id: str, number: int) -> Response:
        if not re.fullmatch(SESSION_PATTERN, identity) or not re.fullmatch(SESSION_PATTERN, asset_id):
            raise HTTPException(404, "Unknown PDF page.")
        async with pdf_slots:
            data = await asyncio.to_thread(pdf_page, identity, asset_id, number)
        return Response(data, media_type="application/pdf", headers={"Cache-Control": "private, max-age=31536000, immutable", "ETag": f'"{asset_id}-{number}"', "X-Content-Type-Options": "nosniff"})
