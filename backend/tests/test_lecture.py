"""Lecture features: laser pointer, marker ink, reader limits, caching and PDF size."""
import hashlib

import pytest
from clients import AuthorizedClient as TestClient, connect
from starlette.websockets import WebSocketDisconnect

from app.main import create_app
from fixtures import IDENTITY, SECRET, stroke
from test_paged import edit, hello, recover, subscribe


def published(client):
    writer_context = connect(client, '/ws/sync/v2/publish')
    writer = writer_context.__enter__()
    assert hello(writer)['recover']
    recover(writer)
    return writer_context, writer


def test_laser_pointer_reaches_readers_of_that_page_and_is_not_stored(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        context, writer = published(client)
        try:
            with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
                assert viewer.receive_json()['type'] == 'structure'
                assert viewer.receive_json() == {'type': 'source_status', 'connected': True}
                subscribe(viewer)
                writer.send_json({'type': 'pointer', 'pageId': 'a', 'point': {'x': 10, 'y': 20}})
                assert viewer.receive_json() == {'type': 'pointer', 'pageId': 'a', 'point': {'x': 10.0, 'y': 20.0}}
                writer.send_json({'type': 'pointer', 'pageId': 'a', 'point': None})
                assert viewer.receive_json() == {'type': 'pointer', 'pageId': 'a', 'point': None}
            page = client.get(f'/api/notebook/{IDENTITY}/page/a/export').json()
            assert [s['id'] for s in page['strokes']] == ['saved']
        finally:
            context.__exit__(None, None, None)


def test_pointer_outside_the_page_is_rejected(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        context, writer = published(client)
        try:
            writer.send_json({'type': 'pointer', 'pageId': 'a', 'point': {'x': 10, 'y': 20, 'pressure': .5}})
            with pytest.raises(WebSocketDisconnect) as closed:
                writer.receive_json()
            assert closed.value.code == 1008
        finally:
            context.__exit__(None, None, None)


def test_highlighter_strokes_round_trip_and_pen_strokes_stay_unchanged(tmp_path):
    marker = {**stroke('mark', 1), 'highlighter': True, 'points': [{'x': 100, 'y': 200, 'pressure': .5}]}
    with TestClient(create_app(tmp_path)) as client:
        context, writer = published(client)
        try:
            writer.send_json(edit(page='b', inserted=[marker]))
            assert writer.receive_json() == {'type': 'ack', 'sequence': 1}
        finally:
            context.__exit__(None, None, None)
        saved = client.get(f'/api/notebook/{IDENTITY}/page/b/export').json()['strokes']
        assert saved[0]['highlighter'] is True
        pen = client.get(f'/api/notebook/{IDENTITY}/page/a/export').json()['strokes'][0]
        assert 'highlighter' not in pen


def test_reader_over_its_request_budget_may_reconnect(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        context, _ = published(client)
        try:
            with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
                for request in range(1, 80):
                    viewer.send_json({'type': 'subscribe', 'pageId': 'a' if request % 2 else 'b', 'request': request})
                with pytest.raises(WebSocketDisconnect) as closed:
                    while True:
                        viewer.receive_json()
                # 1013 "try again later", not the permanent 1008 policy violation.
                assert closed.value.code == 1013
        finally:
            context.__exit__(None, None, None)


def test_static_viewer_modules_revalidate_and_documents_stay_uncached(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        style = client.get('/ui/style.css')
        assert style.status_code == 200, 'build packages/ui before running backend tests'
        assert style.headers['cache-control'] == 'no-cache'
        assert client.get('/ui/style.css', headers={'If-None-Match': style.headers['etag']}).status_code == 304
        assert client.get('/health').headers['cache-control'] == 'no-store'
        assert client.get('/').headers['cache-control'] == 'no-store'


def test_pdfs_above_the_previous_10_mb_limit_are_accepted(tmp_path):
    data = b'%PDF-1.4\n' + b'0' * 12_000_000
    asset = hashlib.sha256(data).hexdigest()
    with TestClient(create_app(tmp_path)) as client:
        response = client.post(f'/api/sync/pdf/{asset}', headers={'Authorization': f'Bearer {SECRET}'}, content=data)
        assert response.status_code == 200
        too_large = b'%PDF-1.4\n' + b'0' * 50_000_000
        response = client.post(f'/api/sync/pdf/{hashlib.sha256(too_large).hexdigest()}', headers={'Authorization': f'Bearer {SECRET}'}, content=too_large)
        assert response.status_code == 413


def test_notebook_page_links_its_own_home_screen_manifest(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        context, _ = published(client)
        context.__exit__(None, None, None)
        page = client.get(f'/notebook/{IDENTITY}')
        assert page.status_code == 200 and f'/manifest/{IDENTITY}.webmanifest' in page.text and '__NOTEBOOK__' not in page.text
        manifest = client.get(f'/manifest/{IDENTITY}.webmanifest')
        assert manifest.headers['content-type'].startswith('application/manifest+json')
        data = manifest.json()
        assert data['start_url'] == f'/notebook/{IDENTITY}' and data['display'] == 'standalone'
        assert data['short_name'] == 'Mathematik'
        assert client.get(data['icons'][0]['src']).status_code == 200
        assert client.get(f'/manifest/{"f" * 64}.webmanifest').status_code == 404
        assert client.get('/manifest/invalid.webmanifest').status_code == 404


def test_privacy_link_is_configurable_and_escaped(tmp_path, monkeypatch):
    with TestClient(create_app(tmp_path)) as client:
        context, _ = published(client)
        context.__exit__(None, None, None)
        assert 'content=""' in client.get(f'/notebook/{IDENTITY}').text.split('livemitschrift-privacy')[1][:20]
    monkeypatch.setenv('LIVEMITSCHRIFT_PRIVACY_URL', 'https://example.org/datenschutz?a=1&b=2')
    with TestClient(create_app(tmp_path)) as client:
        assert 'content="https://example.org/datenschutz?a=1&amp;b=2"' in client.get(f'/notebook/{IDENTITY}').text
    for invalid in ('http://example.org/', 'javascript:alert(1)', 'https://example.org/"><script>'):
        monkeypatch.setenv('LIVEMITSCHRIFT_PRIVACY_URL', invalid)
        with pytest.raises(ValueError):
            create_app(tmp_path)


def test_source_link_points_to_running_version(tmp_path, monkeypatch):
    upstream = 'https://github.com/andreaszsr/livemitschrift'
    monkeypatch.delenv('LIVEMITSCHRIFT_SOURCE_URL', raising=False)
    monkeypatch.delenv('LIVEMITSCHRIFT_SOURCE_REVISION', raising=False)
    with TestClient(create_app(tmp_path)) as client:
        context, _ = published(client)
        context.__exit__(None, None, None)
        assert f'<a href="{upstream}">Quellcode</a>' in client.get('/').text
        assert f'name="livemitschrift-source" content="{upstream}"' in client.get(f'/notebook/{IDENTITY}').text
    monkeypatch.setenv('LIVEMITSCHRIFT_SOURCE_REVISION', 'v0.1.0')
    with TestClient(create_app(tmp_path)) as client:
        assert f'content="{upstream}/tree/v0.1.0"' in client.get(f'/notebook/{IDENTITY}').text
    monkeypatch.setenv('LIVEMITSCHRIFT_SOURCE_URL', 'https://example.org/fork?a=1&b=2')
    with TestClient(create_app(tmp_path)) as client:
        assert 'href="https://example.org/fork?a=1&amp;b=2">Quellcode' in client.get('/').text
    for name, invalid in (('LIVEMITSCHRIFT_SOURCE_URL', 'http://example.org/'), ('LIVEMITSCHRIFT_SOURCE_URL', 'https://example.org/"><script>'),
                          ('LIVEMITSCHRIFT_SOURCE_URL', 'javascript:alert(1)'), ('LIVEMITSCHRIFT_SOURCE_REVISION', '../evil')):
        monkeypatch.delenv('LIVEMITSCHRIFT_SOURCE_URL', raising=False)
        monkeypatch.setenv(name, invalid)
        with pytest.raises(ValueError):
            create_app(tmp_path)


def test_search_engines_are_kept_away(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        robots = client.get('/robots.txt')
        assert robots.status_code == 200 and 'Disallow: /' in robots.text
        for path in ('/', '/health', '/robots.txt', '/ui/style.css'):
            assert client.get(path).headers['x-robots-tag'] == 'noindex, nofollow, noarchive'
        assert '<meta name="robots" content="noindex' in client.get('/').text


def test_operator_privacy_page_is_served_and_linked(tmp_path, monkeypatch):
    with TestClient(create_app(tmp_path)) as client:
        assert client.get('/datenschutz').status_code == 404
        assert 'Datenschutz' not in client.get('/').text
    notice = tmp_path / 'datenschutz.html'
    notice.write_text('<h1>Datenschutzhinweise</h1><p>Verantwortlich: Test</p>', encoding='utf-8')
    monkeypatch.setenv('LIVEMITSCHRIFT_PRIVACY_FILE', str(notice))
    with TestClient(create_app(tmp_path)) as client:
        context, _ = published(client)
        context.__exit__(None, None, None)
        page = client.get('/datenschutz')
        assert page.status_code == 200 and 'Verantwortlich: Test' in page.text and 'noindex' in page.text
        assert 'href="/datenschutz"' in client.get('/').text
        assert 'content="/datenschutz"' in client.get(f'/notebook/{IDENTITY}').text
