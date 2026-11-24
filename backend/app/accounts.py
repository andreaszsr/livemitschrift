"""Publishing accounts: users, personal keys (stored only as SHA-256) and ownership.

Readers never need an account. The configured operator key keeps working as the
built-in administrator account `admin`.
"""
from dataclasses import dataclass
import hashlib
import re
import secrets
import time

from .page_store import PageStore

USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
BUILTIN_ADMIN = "admin"


@dataclass(frozen=True)
class Publisher:
    user_id: int
    username: str
    role: str
    token_hash: str | None  # None for the configured operator key

    @property
    def admin(self) -> bool:
        return self.role == "admin"


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode("ascii")).hexdigest()


def normalize_username(name: str) -> str:
    """SSO-style names are case-insensitive; a mail-style suffix is not part of the name."""
    username = name.strip().lower().split("@", 1)[0]
    if not USERNAME.fullmatch(username):
        raise ValueError("Benutzername: 1–64 Zeichen a–z, 0–9, Punkt, Bindestrich, Unterstrich.")
    return username


class Accounts:
    def __init__(self, store: PageStore) -> None:
        self.store = store

    def ensure_builtin_admin(self) -> int:
        with self.store.connect() as db:
            db.execute("INSERT OR IGNORE INTO users(username,display_name,role,created) VALUES(?,?,?,?)",
                       (BUILTIN_ADMIN, "Administrator", "admin", int(time.time())))
            return db.execute("SELECT id FROM users WHERE username=?", (BUILTIN_ADMIN,)).fetchone()[0]

    def builtin_admin(self) -> Publisher:
        return Publisher(self.ensure_builtin_admin(), BUILTIN_ADMIN, "admin", None)

    def has_active_tokens(self) -> bool:
        with self.store.connect() as db:
            return db.execute("SELECT 1 FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.revoked=0 AND u.disabled=0 LIMIT 1").fetchone() is not None

    def resolve(self, key: str) -> Publisher | None:
        """A personal key of an enabled user, or None. Lookup is by hash, never by key."""
        digest = key_hash(key)
        with self.store.connect() as db:
            row = db.execute("SELECT u.id,u.username,u.role FROM tokens t JOIN users u ON u.id=t.user_id "
                             "WHERE t.hash=? AND t.revoked=0 AND u.disabled=0", (digest,)).fetchone()
            if row:
                db.execute("UPDATE tokens SET last_used=? WHERE hash=?", (int(time.time()), digest))
        return Publisher(row[0], row[1], row[2], digest) if row else None

    def still_valid(self, publisher: Publisher) -> bool:
        """Re-checked during long publishing sessions so revocation takes effect."""
        if publisher.token_hash is None:
            return True
        with self.store.connect() as db:
            return db.execute("SELECT 1 FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=? AND t.revoked=0 AND u.disabled=0",
                              (publisher.token_hash,)).fetchone() is not None

    # ---- administration (CLI) -------------------------------------------
    def add_user(self, name: str, display_name: str | None = None, admin: bool = False) -> int:
        username = normalize_username(name)
        if username == BUILTIN_ADMIN:
            raise ValueError("Der Name „admin“ ist für das eingebaute Konto reserviert.")
        with self.store.connect() as db:
            if db.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
                raise ValueError(f"Benutzer {username} existiert bereits.")
            cursor = db.execute("INSERT INTO users(username,display_name,role,created) VALUES(?,?,?,?)",
                                (username, (display_name or username)[:200], "admin" if admin else "lecturer", int(time.time())))
            return int(cursor.lastrowid)

    def user_id(self, name: str) -> int:
        with self.store.connect() as db:
            row = db.execute("SELECT id FROM users WHERE username=?", (normalize_username(name),)).fetchone()
        if not row:
            raise ValueError(f"Unbekannter Benutzer {name}.")
        return row[0]

    def set_disabled(self, name: str, disabled: bool) -> None:
        user = self.user_id(name)
        with self.store.connect() as db:
            db.execute("UPDATE users SET disabled=? WHERE id=?", (int(disabled), user))

    def create_token(self, name: str, label: str = "Mac") -> str:
        """Returns the new key once; only its hash is stored."""
        user = self.user_id(name)
        key = secrets.token_hex(32)
        with self.store.connect() as db:
            db.execute("INSERT INTO tokens(hash,user_id,label,created) VALUES(?,?,?,?)", (key_hash(key), user, label[:100] or "Mac", int(time.time())))
        return key

    def revoke_token(self, name: str, token_id: int) -> None:
        user = self.user_id(name)
        with self.store.connect() as db:
            if db.execute("UPDATE tokens SET revoked=1 WHERE id=? AND user_id=?", (token_id, user)).rowcount != 1:
                raise ValueError("Unbekannter Schlüssel für diesen Benutzer.")

    def users(self) -> list[dict]:
        with self.store.connect() as db:
            rows = db.execute("SELECT u.username,u.display_name,u.role,u.disabled,"
                              "(SELECT count(*) FROM tokens t WHERE t.user_id=u.id AND t.revoked=0),"
                              "(SELECT count(*) FROM notebooks n WHERE n.owner_id=u.id) FROM users u ORDER BY u.username").fetchall()
        return [{"username": r[0], "name": r[1], "role": r[2], "disabled": bool(r[3]), "keys": r[4], "notebooks": r[5]} for r in rows]

    def tokens(self, name: str) -> list[dict]:
        user = self.user_id(name)
        with self.store.connect() as db:
            rows = db.execute("SELECT id,label,created,last_used,revoked FROM tokens WHERE user_id=? ORDER BY id", (user,)).fetchall()
        return [{"id": r[0], "label": r[1], "created": r[2], "last_used": r[3], "revoked": bool(r[4])} for r in rows]

    def notebooks(self) -> list[dict]:
        import json
        with self.store.connect() as db:
            rows = db.execute("SELECT n.identity,n.snapshot,u.username FROM notebooks n LEFT JOIN users u ON u.id=n.owner_id ORDER BY u.username,n.identity").fetchall()
        return [{"identity": r[0], "title": json.loads(r[1])["notebook"]["title"], "owner": r[2]} for r in rows]

    def transfer(self, identity_prefix: str, name: str) -> str:
        if not re.fullmatch(r"[a-f0-9]{8,64}", identity_prefix):
            raise ValueError("Bitte mindestens 8 Zeichen der Notizbuch-Kennung angeben.")
        user = self.user_id(name)
        with self.store.connect() as db:
            matches = [r[0] for r in db.execute("SELECT identity FROM notebooks WHERE identity LIKE ?", (identity_prefix + "%",))]
            if len(matches) != 1:
                raise ValueError("Kennung nicht eindeutig oder unbekannt.")
            db.execute("UPDATE notebooks SET owner_id=? WHERE identity=?", (user, matches[0]))
        return matches[0]
