"""Personal publisher keys, notebook ownership, quotas, revocation and the admin CLI."""
from contextlib import contextmanager
import hashlib
import sqlite3

import pytest
from starlette.websockets import WebSocketDisconnect

from app.accounts import Accounts, normalize_username
from app.main import create_app
from app.page_store import PageStore, metadata
from app.users import main as users_cli
from clients import AuthorizedClient as TestClient, TEST_KEY
from fixtures import IDENTITY, SECRET, snapshot
from test_paged import edit

HEAD = 'a' * 64
OTHER_SECRET = '8' * 64
OTHER_IDENTITY = hashlib.sha256(OTHER_SECRET.encode()).hexdigest()


@contextmanager
def publisher(client, key):
    with client.websocket_connect('wss://testserver/ws/sync/v2/publish') as socket:
        socket.send_json({'type': 'authenticate', 'key': key})
        yield socket


def publish(socket, secret=SECRET):
    assert socket.receive_json() == {'type': 'authenticated'}
    socket.send_json({'type': 'hello', 'secret': secret, 'sequence': 0, 'head': HEAD, 'firstPending': None})
    resume = socket.receive_json()
    assert resume['type'] == 'resume'
    state = snapshot()
    socket.send_json({'type': 'recover_begin', 'sequence': 0, 'head': HEAD, 'snapshot': metadata(state)})
    for topic in state['notebook']['topics']:
        for page in topic['pages']:
            socket.send_json({'type': 'recover_page', 'page': page})
            socket.receive_json()
    socket.send_json({'type': 'recover_end'})
    return socket.receive_json()


def closed_code(socket):
    with pytest.raises(WebSocketDisconnect) as closed:
        while True:
            socket.receive_json()
    return closed.value.code


def setup_users(tmp_path):
    accounts = Accounts(PageStore(tmp_path))
    accounts.add_user('mustermann', 'Erika Mustermann')
    accounts.add_user('schmidt')
    return accounts, accounts.create_token('mustermann'), accounts.create_token('schmidt')


def test_personal_key_publishes_and_owns_the_notebook(tmp_path):
    accounts, erika, other = setup_users(tmp_path)
    with TestClient(create_app(tmp_path)) as client:
        with publisher(client, erika) as socket:
            assert publish(socket) == {'type': 'ack', 'sequence': 0}
        assert accounts.notebooks()[0]['owner'] == 'mustermann'
        # Another lecturer, and even an administrator, cannot publish into it.
        for key in (other, TEST_KEY):
            with publisher(client, key) as socket:
                assert socket.receive_json() == {'type': 'authenticated'}
                socket.send_json({'type': 'hello', 'secret': SECRET, 'sequence': 0, 'head': HEAD, 'firstPending': None})
                assert closed_code(socket) == 4403


def test_keys_are_stored_hashed_and_revocation_or_disabling_blocks_access(tmp_path):
    accounts, erika, _ = setup_users(tmp_path)
    with sqlite3.connect(tmp_path / 'notebooks.sqlite3') as db:
        assert erika not in {row[0] for row in db.execute('SELECT hash FROM tokens')}
    with TestClient(create_app(tmp_path)) as client:
        accounts.set_disabled('mustermann', True)
        with publisher(client, erika) as socket:
            assert closed_code(socket) == 4401
        accounts.set_disabled('mustermann', False)
        accounts.revoke_token('mustermann', accounts.tokens('mustermann')[0]['id'])
        with publisher(client, erika) as socket:
            assert closed_code(socket) == 4401


def test_revocation_ends_a_running_publishing_session_at_the_next_commit(tmp_path):
    accounts, erika, _ = setup_users(tmp_path)
    with TestClient(create_app(tmp_path)) as client:
        with publisher(client, erika) as socket:
            assert publish(socket)['type'] == 'ack'
            accounts.revoke_token('mustermann', accounts.tokens('mustermann')[0]['id'])
            socket.send_json(edit(sequence=1))
            assert closed_code(socket) == 4401


def test_existing_ownerless_notebooks_are_claimed_by_their_first_publisher(tmp_path):
    accounts, erika, other = setup_users(tmp_path)
    with TestClient(create_app(tmp_path)) as client:
        with publisher(client, erika) as socket:
            publish(socket)
        with sqlite3.connect(tmp_path / 'notebooks.sqlite3') as db:
            db.execute('UPDATE notebooks SET owner_id=NULL')
        with publisher(client, other) as socket:
            assert socket.receive_json() == {'type': 'authenticated'}
            socket.send_json({'type': 'hello', 'secret': SECRET, 'sequence': 0, 'head': HEAD, 'firstPending': None})
            assert socket.receive_json()['type'] == 'resume'
        assert accounts.notebooks()[0]['owner'] == 'schmidt'


def test_personal_notebook_quota(tmp_path, monkeypatch):
    monkeypatch.setenv('LIVEMITSCHRIFT_MAX_NOTEBOOKS_PER_USER', '1')
    _, erika, _ = setup_users(tmp_path)
    with TestClient(create_app(tmp_path)) as client:
        with publisher(client, erika) as socket:
            assert publish(socket)['type'] == 'ack'
        with publisher(client, erika) as socket:
            assert socket.receive_json() == {'type': 'authenticated'}
            socket.send_json({'type': 'hello', 'secret': OTHER_SECRET, 'sequence': 0, 'head': HEAD, 'firstPending': None})
            socket.receive_json()
            socket.send_json({'type': 'recover_begin', 'sequence': 0, 'head': HEAD, 'snapshot': metadata(snapshot())})
            for topic in snapshot()['notebook']['topics']:
                for page in topic['pages']:
                    socket.send_json({'type': 'recover_page', 'page': page}); socket.receive_json()
            socket.send_json({'type': 'recover_end'})
            assert closed_code(socket) == 4413


def test_withdraw_and_pdf_upload_respect_ownership(tmp_path):
    _, erika, other = setup_users(tmp_path)
    data = b'%PDF- fixture'; asset = hashlib.sha256(data).hexdigest()
    key = lambda value: {'X-LiveMitschrift-Publisher-Key': value}
    with TestClient(create_app(tmp_path)) as client:
        with publisher(client, erika) as socket:
            publish(socket)
        upload = {'Authorization': f'Bearer {SECRET}'}
        assert client.post(f'/api/sync/pdf/{asset}', content=data, headers={**upload, **key(other)}).status_code == 403
        assert client.post(f'/api/sync/pdf/{asset}', content=data, headers={**upload, **key(erika)}).status_code == 200
        assert client.delete(f'/api/notebook/{IDENTITY}', headers=key(other)).status_code == 403
        assert client.delete(f'/api/notebook/{OTHER_IDENTITY}', headers=key(other)).status_code == 404
        assert client.delete(f'/api/notebook/{IDENTITY}', headers=key(erika)).status_code == 204
        # Administrators may withdraw any identity, e.g. after abuse.
        assert client.delete(f'/api/notebook/{OTHER_IDENTITY}', headers=key(TEST_KEY)).status_code == 204


def test_failed_authentication_is_throttled_per_client(tmp_path):
    setup_users(tmp_path)
    with TestClient(create_app(tmp_path)) as client:
        codes = [client.delete(f'/api/notebook/{IDENTITY}', headers={'X-LiveMitschrift-Publisher-Key': 'e' * 64}).status_code for _ in range(12)]
        assert codes[:10] == [401] * 10 and codes[-1] == 429


def test_version_1_database_migrates_without_losing_notebooks(tmp_path):
    with sqlite3.connect(tmp_path / 'notebooks.sqlite3') as db:
        db.execute('CREATE TABLE notebooks(identity TEXT PRIMARY KEY, sequence INTEGER NOT NULL, snapshot TEXT NOT NULL, head TEXT NOT NULL)')
        db.execute("INSERT INTO notebooks VALUES('x', 3, '{\"notebook\":{\"title\":\"Alt\"}}', 'h')")
        db.execute('PRAGMA user_version=1')
    store = PageStore(tmp_path)
    with store.connect() as db:
        assert db.execute('PRAGMA user_version').fetchone() == (2,)
        assert db.execute('SELECT sequence, owner_id FROM notebooks').fetchone() == (3, None)
    assert Accounts(store).notebooks() == [{'identity': 'x', 'title': 'Alt', 'owner': None}]


def test_usernames_are_normalized_and_validated():
    assert normalize_username(' Mustermann@Example.edu ') == 'mustermann'
    for invalid in ('', '-x', 'a b', 'ä', 'x' * 65):
        with pytest.raises(ValueError):
            normalize_username(invalid)


def test_admin_cli_manages_users_keys_and_ownership(tmp_path, capsys):
    run = lambda *args: users_cli(list(args), directory=tmp_path) or capsys.readouterr().out
    assert 'Angelegt' in run('add', 'mustermann', '--name', 'Erika Mustermann')
    with pytest.raises(SystemExit):
        run('add', 'admin')
    key = run('key-create', 'mustermann', '--label', 'MacBook').strip().splitlines()[-1]
    assert len(key) == 64 and Accounts(PageStore(tmp_path)).resolve(key).username == 'mustermann'
    assert 'Schlüssel: 1' in run('list')
    assert 'MacBook' in run('keys', 'mustermann')
    run('key-revoke', 'mustermann', '1')
    assert Accounts(PageStore(tmp_path)).resolve(key) is None
    assert 'WIDERRUFEN' in run('keys', 'mustermann')
    with TestClient(create_app(tmp_path)) as client:
        with publisher(client, TEST_KEY) as socket:
            publish(socket)
    assert 'admin' in run('notebooks')
    assert 'gehört jetzt mustermann' in run('transfer', IDENTITY[:12], 'mustermann')
    assert 'mustermann' in run('notebooks')
