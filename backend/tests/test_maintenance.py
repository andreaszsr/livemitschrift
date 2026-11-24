import io
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.maintenance import restore, verify
from app.page_store import PageStore
from app.paged import PageFrames, Transfers
from app.room import ProtocolError


def test_restore_checks_integrity_before_replacing_and_refuses_running_server(tmp_path, monkeypatch):
    PageStore(tmp_path)
    original = (tmp_path/'notebooks.sqlite3').read_bytes()
    destination = tmp_path/'restoring.sqlite3'
    monkeypatch.setattr('sys.stdin', SimpleNamespace(buffer=io.BytesIO(b'not sqlite')))
    with pytest.raises(sqlite3.DatabaseError): restore(tmp_path, destination)
    assert (tmp_path/'notebooks.sqlite3').read_bytes() == original
    with TestClient(create_app(tmp_path)):
        monkeypatch.setattr('sys.stdin', SimpleNamespace(buffer=io.BytesIO(original)))
        with pytest.raises(ValueError, match='Stop the backend'): restore(tmp_path, destination)
    monkeypatch.setattr('sys.stdin', SimpleNamespace(buffer=io.BytesIO(original)))
    restore(tmp_path, destination)
    verify(tmp_path/'notebooks.sqlite3')


def test_frame_cache_has_one_shared_budget_and_lru_eviction():
    cache = PageFrames()
    for number in range(16): cache.put((str(number), 'page', 'head'), ('fixture',))
    assert cache.get(('0', 'page', 'head')) == ('fixture',)
    cache.put(('16', 'page', 'head'), ('fixture',))
    assert cache.get(('1', 'page', 'head')) is None
    assert len(cache.values) == 16
    assert cache.size == 16 * len('fixture')


@pytest.mark.parametrize('text', ['', 'x'*32001])
def test_transfer_rejects_empty_or_overlong_chunks(text):
    transfer = Transfers(); transfer.receive({'type':'transfer_start'})
    with pytest.raises(ProtocolError): transfer.receive({'type':'transfer_chunk', 'text':text})
