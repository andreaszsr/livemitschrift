"""Normalized single-writer storage. Only changed stroke rows are written per edit."""
import hashlib
import json
import sqlite3
import os
import tempfile
from typing import Any
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path

from .notebook import Page, Snapshot, EditEvent, MAX_POINTS
from .room import ProtocolError
from .protocol import MAX_NOTEBOOK_ASSETS, MAX_NOTEBOOK_ASSET_BYTES, MAX_NOTEBOOK_IMAGES, MAX_NOTEBOOK_IMAGE_BYTES

class QuotaExceeded(ProtocolError):
    pass


MAX_PAGE_BYTES = 64_000_000
MAX_TRANSFER_BYTES = 128_000_000
MAX_FRAME_BYTES = 256_000
CHUNK_CHARACTERS = 32_000


def encoded(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def metadata(state: dict) -> dict:
    result = json.loads(json.dumps(state))
    for topic in result["notebook"]["topics"]:
        for page in topic["pages"]:
            page["strokes"] = []
    return result


class Recovery:
    """An interrupted upload only touches a disposable staging database."""
    def __init__(self, directory: Path | None = None, max_bytes: int = 4 * 1024**3) -> None:
        self.filename = None
        if directory is not None:
            descriptor, self.filename = tempfile.mkstemp(prefix=".incoming-", suffix=".sqlite3", dir=directory)
            os.close(descriptor)
        self.db = sqlite3.connect(self.filename or "", check_same_thread=False)
        self.db.execute(f"PRAGMA max_page_count={max_bytes // 4096}")
        self.db.execute("CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT NOT NULL)")

    def put(self, value: dict) -> None:
        page = Page.model_validate(value)
        if any(not s.complete for s in page.strokes) or sum(len(s.points) for s in page.strokes) > MAX_POINTS:
            raise ProtocolError("Invalid durable page.")
        payload = encoded(page.model_dump(by_alias=True))
        if len(payload.encode()) > MAX_PAGE_BYTES:
            raise ProtocolError("Page exceeds 64 MB.")
        self.db.execute("INSERT INTO pages VALUES(?,?)", (page.id, payload))
        self.db.commit()

    def close(self) -> None:
        self.db.close()
        if self.filename:
            Path(self.filename).unlink(missing_ok=True)


class PageStore:
    def __init__(self, directory: Path, *, max_bytes: int = 4 * 1024**3, max_notebooks: int = 128) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "notebooks.sqlite3"
        self.max_bytes, self.max_notebooks = max_bytes, max_notebooks
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2):
                raise RuntimeError("Unsupported LiveMitschrift server database version.")
            for statement in (
                "CREATE TABLE IF NOT EXISTS notebooks(identity TEXT PRIMARY KEY, sequence INTEGER NOT NULL, snapshot TEXT NOT NULL, head TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS pages(identity TEXT NOT NULL,page_id TEXT NOT NULL,metadata TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(identity,page_id))",
                "CREATE TABLE IF NOT EXISTS strokes(identity TEXT NOT NULL,page_id TEXT NOT NULL,stroke_id TEXT NOT NULL,stroke_order INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(identity,page_id,stroke_id),UNIQUE(identity,page_id,stroke_order))",
                "CREATE TABLE IF NOT EXISTS commits(identity TEXT NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(identity,sequence))",
                "CREATE TABLE IF NOT EXISTS assets(identity TEXT NOT NULL,asset_id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(identity,asset_id))",
                "CREATE TABLE IF NOT EXISTS pdf_pages(identity TEXT NOT NULL,asset_id TEXT NOT NULL,page_number INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(identity,asset_id,page_number))",
            ):
                db.execute(statement)
            db.execute("CREATE TABLE IF NOT EXISTS withdrawn(identity TEXT PRIMARY KEY)")
            # Version 2 (additive): publishing accounts, personal keys and notebook owners.
            db.execute("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','lecturer')), disabled INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, oidc_subject TEXT UNIQUE)")
            db.execute("CREATE TABLE IF NOT EXISTS tokens(id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0)")
            if "owner_id" not in {row[1] for row in db.execute("PRAGMA table_info(notebooks)")}:
                db.execute("ALTER TABLE notebooks ADD COLUMN owner_id INTEGER REFERENCES users(id)")
            # Additive (release 0.3): page images share the assets table. The schema version is
            # unchanged, so a 0.2 server can still open the database after a rollback.
            if "kind" not in {row[1] for row in db.execute("PRAGMA table_info(assets)")}:
                db.execute("ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf'")
            db.execute("PRAGMA user_version=2")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        db.execute(f"PRAGMA max_page_count={self.max_bytes // 4096}")
        try:
            with db:
                yield db
        finally:
            db.close()

    def status(self, identity: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT sequence,head FROM notebooks WHERE identity=?", (identity,)).fetchone()
        return {"sequence": row[0], "head": row[1]} if row else None

    def assets(self, identity: str) -> list[str]:
        with self.connect() as db:
            return [r[0] for r in db.execute("SELECT asset_id FROM assets WHERE identity=?", (identity,))]

    def structure(self, identity: str) -> dict[str, Any] | None:
        with self.connect() as db:
            db.execute("BEGIN")
            row = db.execute("SELECT snapshot FROM notebooks WHERE identity=?", (identity,)).fetchone()
            if not row:
                return None
            state = json.loads(row[0])
            pages = {r[0]: (json.loads(r[1]), r[2]) for r in db.execute("SELECT page_id,metadata,revision FROM pages WHERE identity=?", (identity,))}
            for topic in state["notebook"]["topics"]:
                for index, page in enumerate(topic["pages"]):
                    info, revision = pages[page["id"]]
                    topic["pages"][index] = {**info, "strokes": [], "revision": revision}
            return state

    @staticmethod
    def _page(db: sqlite3.Connection, identity: str, page_id: str) -> tuple[dict[str, Any], str]:
        row = db.execute("SELECT metadata,revision FROM pages WHERE identity=? AND page_id=?", (identity, page_id)).fetchone()
        if not row:
            raise ProtocolError("Unknown notebook page.")
        page = json.loads(row[0])
        page["strokes"] = [json.loads(r[0]) for r in db.execute("SELECT data FROM strokes WHERE identity=? AND page_id=? ORDER BY stroke_order", (identity, page_id))]
        return page, row[1]

    def page(self, identity: str, page_id: str) -> tuple[dict[str, Any], str]:
        with self.connect() as db:
            db.execute("BEGIN")
            return self._page(db, identity, page_id)

    @staticmethod
    def _write_page(db: sqlite3.Connection, identity: str, page: dict[str, Any], revision: str) -> None:
        info = {**page, "strokes": []}
        db.execute("INSERT INTO pages VALUES(?,?,?,?) ON CONFLICT(identity,page_id) DO UPDATE SET metadata=excluded.metadata,revision=excluded.revision", (identity, page["id"], encoded(info), revision))
        db.execute("DELETE FROM strokes WHERE identity=? AND page_id=?", (identity, page["id"]))
        db.executemany("INSERT INTO strokes VALUES(?,?,?,?,?)", ((identity, page["id"], s["id"], s["order"], encoded(s)) for s in page["strokes"]))

    @staticmethod
    def _resources(db: sqlite3.Connection, identity: str, state: dict[str, Any]) -> None:
        for topic in state["notebook"]["topics"]:
            for page in topic["pages"]:
                asset = page["background"]
                if asset and not db.execute("SELECT 1 FROM assets WHERE identity=? AND asset_id=? AND kind='pdf'", (identity, asset["assetId"])).fetchone():
                    raise ProtocolError("Upload PDF resources before their references.")
                PageStore._image_resources(db, identity, page.get("images", []))

    @staticmethod
    def _image_resources(db: sqlite3.Connection, identity: str, images: list[dict[str, Any]]) -> None:
        for image in images:
            if not db.execute("SELECT 1 FROM assets WHERE identity=? AND asset_id=? AND kind='image'", (identity, image["assetId"])).fetchone():
                raise ProtocolError("Upload images before their references.")

    def owner(self, identity: str) -> int | None:
        with self.connect() as db:
            row = db.execute("SELECT owner_id FROM notebooks WHERE identity=?", (identity,)).fetchone()
        return row[0] if row else None

    def claim(self, identity: str, user_id: int) -> None:
        """Give an existing ownerless notebook (created before accounts existed) to its first publisher."""
        with self.connect() as db:
            db.execute("UPDATE notebooks SET owner_id=? WHERE identity=? AND owner_id IS NULL", (user_id, identity))

    def recover(self, identity: str, sequence: int, head: str, state: dict[str, Any], stage: Recovery, owner_id: int | None = None, max_owned: int | None = None) -> None:
        # Metadata validation has no global ink cap; limits apply to each page.
        clean = Snapshot.model_validate(state).model_dump(by_alias=True)
        wanted = {p["id"] for t in clean["notebook"]["topics"] for p in t["pages"]}
        received = {r[0] for r in stage.db.execute("SELECT id FROM pages")}
        if wanted != received:
            raise ProtocolError("Incomplete notebook recovery.")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM withdrawn WHERE identity=?", (identity,)).fetchone():
                raise ProtocolError("Notebook was withdrawn; use a new notebook identity.")
            if not db.execute("SELECT 1 FROM notebooks WHERE identity=?", (identity,)).fetchone():
                if db.execute("SELECT count(*) FROM notebooks").fetchone()[0] >= self.max_notebooks:
                    raise ProtocolError("Server notebook quota reached.")
                if owner_id is not None and max_owned is not None and db.execute("SELECT count(*) FROM notebooks WHERE owner_id=?", (owner_id,)).fetchone()[0] >= max_owned:
                    raise QuotaExceeded("Personal notebook quota reached.")
            row = db.execute("SELECT sequence,head,snapshot FROM notebooks WHERE identity=?", (identity,)).fetchone()
            if row and (row[0] > sequence or (row[0] == sequence and row[1] not in (None, head))):
                raise ProtocolError("Conflicting local revision.")
            if row and json.loads(row[2])["notebook"]["id"] != clean["notebook"]["id"]:
                raise ProtocolError("Notebook identity cannot change.")
            self._resources(db, identity, clean)
            if row and row[0] == sequence:
                old = json.loads(row[2])["notebook"]
                if old["id"] != clean["notebook"]["id"] or old["title"] != clean["notebook"]["title"]:
                    raise ProtocolError("Conflicting checkpoint at the same revision.")
                for page_id, payload in stage.db.execute("SELECT id,data FROM pages"):
                    if self._page(db, identity, page_id)[0] != json.loads(payload):
                        raise ProtocolError("Conflicting page at the same revision.")
            db.execute("DELETE FROM strokes WHERE identity=?", (identity,))
            db.execute("DELETE FROM pages WHERE identity=?", (identity,))
            expected = {p["id"]: p for t in clean["notebook"]["topics"] for p in t["pages"]}
            for _, payload in stage.db.execute("SELECT id,data FROM pages"):
                page = json.loads(payload)
                if {**page, "strokes": []} != expected[page["id"]]:
                    raise ProtocolError("Page disagrees with recovery manifest.")
                self._write_page(db, identity, page, head)
            db.execute("INSERT INTO notebooks(identity,sequence,snapshot,head,owner_id) VALUES(?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET sequence=excluded.sequence,snapshot=excluded.snapshot,head=excluded.head,owner_id=COALESCE(notebooks.owner_id,excluded.owner_id)", (identity, sequence, encoded(clean), head, owner_id))

    def delta(self, identity: str, sequence: int, head: str, change: dict[str, Any]) -> bool:
        digest = hashlib.sha256(encoded({"sequence": sequence, "head": head, "change": change}).encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT sequence,snapshot,head FROM notebooks WHERE identity=?", (identity,)).fetchone()
            receipt = db.execute("SELECT digest FROM commits WHERE identity=? AND sequence=?", (identity, sequence)).fetchone()
            if receipt:
                if receipt[0] != digest:
                    raise ProtocolError("Conflicting repeated commit.")
                return False
            if not row or sequence != row[0] + 1:
                raise ProtocolError("Out-of-order commit.")
            if change.get("type") == "structure":
                state = json.loads(row[1])
                state["notebook"] = change["notebook"]
                ids = {p["id"] for t in state["notebook"]["topics"] for p in t["pages"]}
                if state["position"]["pageId"] not in ids:
                    state["position"] = {"pageId": next(iter(ids)), "y": 0}
                state = Snapshot.model_validate(state).model_dump(by_alias=True)
                if state["notebook"]["id"] != json.loads(row[1])["notebook"]["id"]:
                    raise ProtocolError("Notebook identity cannot change.")
                self._resources(db, identity, state)
                for topic in state["notebook"]["topics"]:
                    for page in topic["pages"]:
                        if page["strokes"] or page.get("images"):
                            raise ProtocolError("Structure must not contain ink or images.")
                        existing = db.execute("SELECT metadata FROM pages WHERE identity=? AND page_id=?", (identity, page["id"])).fetchone()
                        if existing:
                            old = json.loads(existing[0])
                            page["height"] = max(page["height"], old["height"])
                            page["nextOrder"] = max(page["nextOrder"], old["nextOrder"])
                            # Images are page content like ink; structure changes keep them.
                            if old.get("images"):
                                page["images"] = old["images"]
                            db.execute("UPDATE pages SET metadata=? WHERE identity=? AND page_id=?", (encoded(page), identity, page["id"]))
                        else:
                            self._write_page(db, identity, page, head)
                existing_ids = [r[0] for r in db.execute("SELECT page_id FROM pages WHERE identity=?", (identity,))]
                for page_id in set(existing_ids) - ids:
                    db.execute("DELETE FROM strokes WHERE identity=? AND page_id=?", (identity, page_id))
                    db.execute("DELETE FROM pages WHERE identity=? AND page_id=?", (identity, page_id))
                db.execute("UPDATE notebooks SET snapshot=? WHERE identity=?", (encoded(state), identity))
            else:
                edit = EditEvent.model_validate(change).edit
                page, _ = self._page(db, identity, edit.page_id)
                removed = set(edit.remove)
                strokes = [s for s in page["strokes"] if s["id"] not in removed]
                strokes.extend(s.model_dump(by_alias=True) for s in edit.insert)
                page.update(strokes=sorted(strokes, key=lambda s: s["order"]), height=max(page["height"], edit.height), nextOrder=max(page["nextOrder"], max((s["order"] + 1 for s in strokes), default=0)))
                if edit.insert_images or edit.remove_images:
                    self._image_resources(db, identity, [i.model_dump(by_alias=True) for i in edit.insert_images])
                    removed_images = set(edit.remove_images)
                    images = [i for i in page.get("images", []) if i["id"] not in removed_images]
                    if any(i["id"] == image.id for i in images for image in edit.insert_images):
                        raise ProtocolError("Conflicting image identity.")
                    images.extend(i.model_dump(by_alias=True) for i in edit.insert_images)
                    page["images"] = sorted(images, key=lambda i: i["order"])
                    page["nextOrder"] = max(page["nextOrder"], max((i["order"] + 1 for i in images), default=0))
                    if not page["images"]:
                        del page["images"]
                checked = Page.model_validate(page)
                if sum(len(s.points) for s in checked.strokes) > MAX_POINTS or len(encoded(page).encode()) > MAX_PAGE_BYTES:
                    raise ProtocolError("Page ink limit reached.")
                for stroke_id in removed:
                    db.execute("DELETE FROM strokes WHERE identity=? AND page_id=? AND stroke_id=?", (identity, edit.page_id, stroke_id))
                db.executemany("INSERT INTO strokes VALUES(?,?,?,?,?)", ((identity, edit.page_id, s.id, s.order, encoded(s.model_dump(by_alias=True))) for s in edit.insert))
                db.execute("UPDATE pages SET metadata=?,revision=? WHERE identity=? AND page_id=?", (encoded({**page, "strokes": []}), head, identity, edit.page_id))
            db.execute("UPDATE notebooks SET sequence=?,head=? WHERE identity=?", (sequence, head, identity))
            db.execute("INSERT INTO commits VALUES(?,?,?)", (identity, sequence, digest))
        return True

    def asset(self, identity: str, asset_id: str, kind: str = "pdf") -> bytes | None:
        with self.connect() as db:
            row = db.execute("SELECT data FROM assets WHERE identity=? AND asset_id=? AND kind=?", (identity, asset_id, kind)).fetchone()
        if row and hashlib.sha256(row[0]).hexdigest() != asset_id:
            raise ProtocolError("Damaged server resource.")
        return row[0] if row else None

    def put_asset(self, identity: str, asset_id: str, data: bytes, kind: str = "pdf") -> None:
        """Store a content-addressed PDF or image; PDFs and images have separate budgets."""
        limits = {"pdf": (MAX_NOTEBOOK_ASSETS, MAX_NOTEBOOK_ASSET_BYTES, "Notebook PDF limit reached."),
                  "image": (MAX_NOTEBOOK_IMAGES, MAX_NOTEBOOK_IMAGE_BYTES, "Notebook image limit reached.")}
        max_count, max_bytes, message = limits[kind]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT kind FROM assets WHERE identity=? AND asset_id=?", (identity, asset_id)).fetchone()
            if existing:
                if existing[0] != kind:
                    raise ProtocolError("Resource already stored with another type.")
                return
            count, size = db.execute("SELECT count(*),COALESCE(sum(length(data)),0) FROM assets WHERE identity=? AND kind=?", (identity, kind)).fetchone()
            if count >= max_count or size + len(data) > max_bytes:
                raise ProtocolError(message)
            db.execute("INSERT INTO assets(identity,asset_id,data,kind) VALUES(?,?,?,?)", (identity, asset_id, data, kind))


    def is_withdrawn(self, identity: str) -> bool:
        with self.connect() as db:
            return db.execute("SELECT 1 FROM withdrawn WHERE identity=?", (identity,)).fetchone() is not None

    def withdraw(self, identity: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT OR IGNORE INTO withdrawn VALUES(?)", (identity,))
            for table in ("strokes", "pages", "commits", "assets", "pdf_pages", "notebooks"):
                db.execute(f"DELETE FROM {table} WHERE identity=?", (identity,))
