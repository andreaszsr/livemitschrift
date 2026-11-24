import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.access import KEY_HEADER, PublisherAccess
from app.main import create_app
from app.page_store import PageStore, Recovery, metadata
from clients import TEST_KEY, KEY_HEADERS, AuthorizedClient, connect
from fixtures import SECRET, IDENTITY, snapshot
from test_paged import hello, recover, receive_value


@pytest.mark.parametrize('frame', [None, {'type': 'authenticate', 'key': 'e'*64}, {'type': 'hello', 'secret': SECRET}, {'type': 'authenticate', 'key': TEST_KEY, 'extra': True}])
def test_publisher_rejects_missing_wrong_or_bypassed_authentication(tmp_path, frame):
    with TestClient(create_app(tmp_path, access=PublisherAccess(TEST_KEY))) as client:
        with client.websocket_connect('wss://testserver/ws/sync/v2/publish') as socket:
            socket.send_json(frame)
            with pytest.raises(WebSocketDisconnect) as error:
                socket.receive_json()
            assert error.value.code == 4401
    assert PageStore(tmp_path).status(IDENTITY) is None


def test_upload_requires_both_capabilities_and_valid_immutable_content(tmp_path):
    data = b'%PDF- private fixture'; asset = hashlib.sha256(data).hexdigest()
    with TestClient(create_app(tmp_path), base_url='https://testserver') as client:
        auth = {'Authorization': f'Bearer {SECRET}'}
        assert client.post('/api/sync/pdf/'+asset, content=data, headers=auth).status_code == 401
        assert client.post('/api/sync/pdf/'+asset, content=data, headers={**auth, **KEY_HEADERS}).status_code == 200
        assert client.post('/api/sync/pdf/'+asset, content=data, headers=KEY_HEADERS).status_code == 403
        assert client.post('/api/sync/pdf/'+'a'*64, content=data, headers={**auth, **KEY_HEADERS}).status_code == 400


def test_unconfigured_writer_does_not_disable_confirmed_readers(tmp_path):
    stage = Recovery(); state = snapshot()
    for topic in state['notebook']['topics']:
        for page in topic['pages']: stage.put(page)
    PageStore(tmp_path).recover(IDENTITY, 0, 'a'*64, metadata(state), stage); stage.close()
    with TestClient(create_app(tmp_path, access=PublisherAccess(None)), base_url='https://testserver') as client:
        with client.websocket_connect('wss://testserver/ws/sync/v2/publish') as writer:
            with pytest.raises(WebSocketDisconnect) as failure: writer.receive_json()
            assert failure.value.code == 4503
        with client.websocket_connect(f'wss://testserver/ws/notebook/v2/view/{IDENTITY}') as reader:
            assert reader.receive_json()['type'] == 'structure'


def test_key_configuration_precedence_secret_files_and_value_free_errors(tmp_path, monkeypatch):
    env = tmp_path/'.env'; env.write_text('LIVEMITSCHRIFT_PUBLISHER_KEY='+'f'*64+'\n')
    monkeypatch.delenv('LIVEMITSCHRIFT_PUBLISHER_KEY', raising=False)
    monkeypatch.delenv('LIVEMITSCHRIFT_PUBLISHER_KEY_FILE', raising=False)
    assert PublisherAccess.configured(env).digest == hashlib.sha256(('f'*64).encode()).digest()
    secret = tmp_path/'secret'; secret.write_text(TEST_KEY+'\n')
    monkeypatch.setenv('LIVEMITSCHRIFT_PUBLISHER_KEY_FILE', str(secret))
    assert PublisherAccess.configured(env).digest == hashlib.sha256(TEST_KEY.encode()).digest()
    monkeypatch.setenv('LIVEMITSCHRIFT_PUBLISHER_KEY', TEST_KEY)
    with pytest.raises(ValueError): PublisherAccess.configured(env)
    monkeypatch.delenv('LIVEMITSCHRIFT_PUBLISHER_KEY_FILE')
    monkeypatch.setenv('LIVEMITSCHRIFT_PUBLISHER_KEY', 'never-echo-this')
    with pytest.raises(ValueError) as error: PublisherAccess.configured(env)
    assert 'never-echo-this' not in str(error.value)


def test_untrusted_hosts_origins_plaintext_and_spoofed_proxy_headers_are_rejected(tmp_path):
    with TestClient(create_app(tmp_path), base_url='https://testserver') as client:
        assert client.get('/health', headers={'Host': 'attacker.example'}).status_code == 400
        assert client.get('/health', headers={'Origin': 'https://attacker.example'}).status_code == 403
        assert client.get('/health', headers={'Origin': 'null'}).status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('wss://testserver/ws/sync/v2/publish', headers={'Origin': 'https://attacker.example'}) as socket:
                socket.receive_json()
    with TestClient(create_app(tmp_path), base_url='http://testserver', client=('192.0.2.1', 1000)) as client:
        assert client.get('/health', headers={'X-Forwarded-Proto': 'https'}).status_code == 403


def test_native_cors_and_browser_security_headers(tmp_path):
    with TestClient(create_app(tmp_path), base_url='https://testserver') as client:
        headers = {'Origin': 'tauri://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-livemitschrift-publisher-key'}
        assert client.options('/api/sync/pdf/'+'a'*64, headers=headers).status_code == 200
        denied = client.post('/api/sync/pdf/'+'a'*64, headers={'Origin': 'tauri://localhost'})
        assert denied.status_code == 401 and denied.headers['access-control-allow-origin'] == 'tauri://localhost'
        root = client.get('/')
        assert root.status_code == 200 and root.headers['referrer-policy'] == 'no-referrer'
        assert "frame-ancestors 'none'" in root.headers['content-security-policy']
        assert 'sha256-' in root.headers['content-security-policy']
        for route in ('/docs', '/redoc', '/openapi.json', '/live/'+'a'*64):
            assert client.get(route).status_code == 404


def test_withdrawal_requires_operator_key_closes_readers_and_prevents_republication(tmp_path):
    with AuthorizedClient(create_app(tmp_path)) as client:
        with connect(client, '/ws/sync/v2/publish') as writer:
            hello(writer); recover(writer)
        url = f'/api/notebook/{IDENTITY}'
        assert client.delete(url, headers={KEY_HEADER: 'e'*64}).status_code == 401
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as reader:
            reader.receive_json(); reader.receive_json()
            assert client.delete(url).status_code == 204
            with pytest.raises(WebSocketDisconnect): reader.receive_json()
        assert client.get('/notebook/'+IDENTITY).status_code == 404
        with connect(client, '/ws/sync/v2/publish') as writer:
            writer.send_json({'type':'hello','secret':SECRET,'sequence':0,'head':'a'*64,'firstPending':None})
            with pytest.raises(WebSocketDisconnect): writer.receive_json()


def test_single_backend_process_lock_and_store_quota_fail_closed(tmp_path):
    with TestClient(create_app(tmp_path)):
        with pytest.raises(RuntimeError, match='Only one backend'):
            with TestClient(create_app(tmp_path)): pass


def test_reader_subscription_rate_limit_does_not_allow_writes(tmp_path):
    with AuthorizedClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as reader:
            reader.receive_json(); reader.receive_json()
            for index in range(30): reader.send_json({'type':'subscribe','pageId':'a','request':index})
            with pytest.raises(WebSocketDisconnect):
                while True: reader.receive_json()


def test_reader_limit_has_capacity_for_writer_and_is_released_on_disconnect(tmp_path):
    from app.settings import Settings
    settings = Settings(public_url='https://testserver', max_readers=1)
    with AuthorizedClient(create_app(tmp_path, settings=settings)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as first:
            first.receive_json(); first.receive_json()
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(f'wss://testserver/ws/notebook/v2/view/{IDENTITY}') as second: second.receive_json()
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as replacement:
            assert replacement.receive_json()['type']=='structure'


def test_notebook_and_database_quotas_keep_previous_state_atomic(tmp_path):
    import sqlite3
    store = PageStore(tmp_path, max_notebooks=1)
    stage = Recovery(); state = snapshot()
    for topic in state['notebook']['topics']:
        for page in topic['pages']: stage.put(page)
    store.recover(IDENTITY, 0, 'a'*64, metadata(state), stage)
    with pytest.raises(ValueError, match='quota'): store.recover('f'*64, 0, 'a'*64, metadata(state), stage)
    assert store.status(IDENTITY)['sequence']==0
    stage.close()
    small = PageStore(tmp_path/'small', max_bytes=131072)
    stage = Recovery(); state = snapshot()
    state['notebook']['topics'][0]['pages'][0]['strokes'][0]['points'] *= 10000
    for topic in state['notebook']['topics']:
        for page in topic['pages']: stage.put(page)
    with pytest.raises(sqlite3.Error): small.recover(IDENTITY, 0, 'a'*64, metadata(state), stage)
    assert small.status(IDENTITY) is None
    stage.close()


def test_shared_page_encoding_is_reused_until_revision_changes(tmp_path, monkeypatch):
    calls = []
    original = PageStore.page
    def observed(self, identity, page_id):
        calls.append(page_id)
        return original(self, identity, page_id)
    monkeypatch.setattr(PageStore, 'page', observed)
    with AuthorizedClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        for index in range(3):
            with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as reader:
                reader.receive_json(); reader.receive_json()
                reader.send_json({'type':'subscribe','pageId':'a','request':index+1})
                assert receive_value(reader)['page']['strokes'][0]['id']=='saved'
        assert calls==['a']
        writer.send_json({'type':'commit','sequence':1,'head':'b'*64,'change':{'type':'edit','edit':{'id':'erase','pageId':'a','insert':[],'remove':['saved'],'height':6400}}})
        assert writer.receive_json()['type']=='ack'
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as reader:
            reader.receive_json(); reader.receive_json()
            reader.send_json({'type':'subscribe','pageId':'a','request':1})
            assert receive_value(reader)['page']['strokes']==[]
        assert calls==['a','a']
