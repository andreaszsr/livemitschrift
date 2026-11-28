import hashlib
import sqlite3

import pytest
from clients import AuthorizedClient as TestClient, connect
from starlette.websockets import WebSocketDisconnect

from app.images import image_info, valid_image
from app.main import create_app
from app.page_store import PageStore, metadata
from fixtures import IDENTITY, SECRET, snapshot
from test_paged import HEAD, NEXT, hello, recover, subscribe

AUTH = {'Authorization': f'Bearer {SECRET}'}


def png(width=40, height=30, extra=b''):
    return b'\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR' + width.to_bytes(4, 'big') + height.to_bytes(4, 'big') + b'\x08\x06\0\0\0' + extra


def jpeg(width=80, height=60):
    return b'\xff\xd8\xff\xe0\x00\x04\x00\x00\xff\xc0\x00\x0b\x08' + height.to_bytes(2, 'big') + width.to_bytes(2, 'big') + b'\x01\x01\x11\x00'


def image(identity, asset, x=100, order=1):
    return {'id': identity, 'assetId': asset, 'x': x, 'y': 100, 'width': 300, 'height': 200, 'order': order}


def upload(client, data):
    return client.post(f'/api/sync/image/{hashlib.sha256(data).hexdigest()}', content=data, headers=AUTH)


def image_edit(sequence, insert=(), remove=(), head=NEXT):
    edit = {'id': f'image-edit-{sequence}', 'pageId': 'b', 'insert': [], 'remove': [], 'height': 6400}
    if insert: edit['insertImages'] = list(insert)
    if remove: edit['removeImages'] = list(remove)
    return {'type': 'commit', 'sequence': sequence, 'head': head, 'change': {'type': 'edit', 'edit': edit}}


def test_image_headers_are_checked_without_decoding():
    assert image_info(png(640, 480)) == ('image/png', 640, 480)
    assert image_info(jpeg(800, 600)) == ('image/jpeg', 800, 600)
    assert valid_image(png(4097, 10)) is None and valid_image(png(0, 10)) is None
    assert valid_image(b'GIF89a') is None and valid_image(b'\xff\xd8\xff') is None
    assert valid_image(jpeg(4096, 4096)) == 'image/jpeg'


def test_image_uploads_require_the_capability_a_known_type_size_and_matching_hash(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        assert upload(client, png()).status_code == 200
        assert upload(client, jpeg()).status_code == 200
        assert upload(client, b'GIF89a not allowed').status_code == 400
        assert upload(client, png(5000, 10)).status_code == 400
        assert client.post('/api/sync/image/' + 'a' * 64, content=png(), headers=AUTH).status_code == 400
        assert client.post(f'/api/sync/image/{hashlib.sha256(png()).hexdigest()}', content=png()).status_code == 403
        too_large = png(extra=b'0' * 10_000_001)
        assert upload(client, too_large).status_code == 413
        # A PDF identity cannot be reused for an image (and vice versa).
        pdf = b'%PDF- fixture'
        assert client.post(f'/api/sync/pdf/{hashlib.sha256(pdf).hexdigest()}', content=pdf, headers=AUTH).status_code == 200
        assert client.post(f'/api/sync/image/{hashlib.sha256(pdf).hexdigest()}', content=pdf, headers=AUTH).status_code == 400


def test_recovery_needs_uploaded_images_and_readers_get_only_referenced_images(tmp_path):
    data, other = png(), jpeg()
    asset, unused = hashlib.sha256(data).hexdigest(), hashlib.sha256(other).hexdigest()
    state = snapshot()
    page = state['notebook']['topics'][0]['pages'][1]
    page['images'], page['nextOrder'] = [image('img', asset)], 2
    with TestClient(create_app(tmp_path)) as client:
        with connect(client, '/ws/sync/v2/publish') as writer:
            hello(writer)
            with pytest.raises(Exception): recover(writer, state)
        with connect(client, '/ws/sync/v2/publish') as writer:
            hello(writer)
            assert upload(client, data).status_code == 200 and upload(client, other).status_code == 200
            recover(writer, state)
        response = client.get(f'/api/notebook/{IDENTITY}/image/{asset}')
        assert response.status_code == 200 and response.content == data
        assert response.headers['content-type'] == 'image/png'
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert "default-src 'self'" in response.headers['content-security-policy']
        assert client.get(f'/api/notebook/{IDENTITY}/image/{unused}').status_code == 404
        assert client.get(f'/api/notebook/{IDENTITY}/image/' + 'z' * 64).status_code == 404
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
            viewer.receive_json(); viewer.receive_json()
            assert subscribe(viewer, 'b')['page']['images'] == [image('img', asset)]


def test_image_edits_insert_move_remove_and_survive_structure_changes(tmp_path):
    data = png(); asset = hashlib.sha256(data).hexdigest()
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
            viewer.receive_json(); viewer.receive_json()
            subscribe(viewer, 'b')
            # Referencing a file that was never uploaded is rejected.
            writer.send_json(image_edit(1, [image('img', asset)]))
            with pytest.raises(WebSocketDisconnect): writer.receive_json()
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer)
        assert upload(client, data).status_code == 200
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
            viewer.receive_json(); viewer.receive_json()
            subscribe(viewer, 'b')
            writer.send_json(image_edit(1, [image('img', asset)])); assert writer.receive_json()['type'] == 'ack'
            assert viewer.receive_json()['type'] == 'extent'
            event = viewer.receive_json()
            assert event['type'] == 'edit' and event['edit']['insertImages'][0]['assetId'] == asset
        stored = PageStore(tmp_path).page(IDENTITY, 'b')[0]
        assert stored['images'] == [image('img', asset)] and stored['nextOrder'] == 2
        writer.send_json(image_edit(2, [image('img', asset, x=500)], ['img'], head='c' * 64)); assert writer.receive_json()['type'] == 'ack'
        assert PageStore(tmp_path).page(IDENTITY, 'b')[0]['images'][0]['x'] == 500
        # A structure change (rename) carries no images but keeps them on the page.
        change = {'type': 'structure', 'notebook': metadata(snapshot())['notebook']}; change['notebook']['title'] = 'Renamed'
        writer.send_json({'type': 'commit', 'sequence': 3, 'head': 'd' * 64, 'change': change}); assert writer.receive_json()['type'] == 'ack'
        assert len(PageStore(tmp_path).page(IDENTITY, 'b')[0]['images']) == 1
        assert client.get(f'/api/notebook/{IDENTITY}/image/{asset}').status_code == 200
        writer.send_json(image_edit(4, [], ['img'], head='e' * 64)); assert writer.receive_json()['type'] == 'ack'
        assert 'images' not in PageStore(tmp_path).page(IDENTITY, 'b')[0]
        assert client.get(f'/api/notebook/{IDENTITY}/image/{asset}').status_code == 404


def test_invalid_image_placements_and_structures_with_images_are_rejected(tmp_path):
    data = png(); asset = hashlib.sha256(data).hexdigest()
    for bad in (image('img', asset, x=1000), {**image('img', asset), 'width': 5}, {**image('img', asset), 'extra': 1}):
        with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
            hello(writer); recover(writer)
            assert upload(client, data).status_code == 200
            writer.send_json(image_edit(1, [bad]))
            with pytest.raises(WebSocketDisconnect): writer.receive_json()
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        change = {'type': 'structure', 'notebook': metadata(snapshot())['notebook']}
        change['notebook']['topics'][0]['pages'][1].update(images=[image('img', asset)], nextOrder=2)
        writer.send_json({'type': 'commit', 'sequence': 1, 'head': NEXT, 'change': change})
        with pytest.raises(WebSocketDisconnect): writer.receive_json()


def test_image_budget_is_separate_from_pdfs_and_old_databases_gain_the_kind_column(tmp_path):
    PageStore(tmp_path)
    with sqlite3.connect(tmp_path / 'notebooks.sqlite3') as db:
        assert 'kind' in {row[1] for row in db.execute('PRAGMA table_info(assets)')}
        assert db.execute('PRAGMA user_version').fetchone()[0] == 2, 'additive change keeps rollback to 0.2 possible'
    store = PageStore(tmp_path)
    store.put_asset(IDENTITY, hashlib.sha256(b'%PDF- a').hexdigest(), b'%PDF- a')
    store.put_asset(IDENTITY, hashlib.sha256(png()).hexdigest(), png(), 'image')
    assert store.asset(IDENTITY, hashlib.sha256(png()).hexdigest()) is None, 'images are not readable as PDFs'
    assert store.asset(IDENTITY, hashlib.sha256(png()).hexdigest(), 'image') == png()


def text_box(identity, text='Skript: https://example.org', order=1, **extra):
    return {'id': identity, 'x': 100, 'y': 200, 'width': 500, 'text': text, 'size': 'medium', 'color': '#243147', 'code': False, 'order': order, **extra}


def text_edit(sequence, insert=(), remove=(), head=NEXT):
    edit = {'id': f'text-edit-{sequence}', 'pageId': 'b', 'insert': [], 'remove': [], 'height': 6400}
    if insert: edit['insertTexts'] = list(insert)
    if remove: edit['removeTexts'] = list(remove)
    return {'type': 'commit', 'sequence': sequence, 'head': head, 'change': {'type': 'edit', 'edit': edit}}


def test_text_boxes_are_committed_shown_to_readers_and_kept_across_structure_changes(tmp_path):
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
            viewer.receive_json(); viewer.receive_json()
            subscribe(viewer, 'b')
            writer.send_json(text_edit(1, [text_box('note')])); assert writer.receive_json()['type'] == 'ack'
            assert viewer.receive_json()['type'] == 'extent'
            assert viewer.receive_json()['edit']['insertTexts'][0]['text'] == 'Skript: https://example.org'
        writer.send_json(text_edit(2, [text_box('note', 'Neu')], ['note'], head='c' * 64)); assert writer.receive_json()['type'] == 'ack'
        change = {'type': 'structure', 'notebook': metadata(snapshot())['notebook']}; change['notebook']['title'] = 'Renamed'
        writer.send_json({'type': 'commit', 'sequence': 3, 'head': 'd' * 64, 'change': change}); assert writer.receive_json()['type'] == 'ack'
        assert PageStore(tmp_path).page(IDENTITY, 'b')[0]['texts'] == [text_box('note', 'Neu')]
        writer.send_json(text_edit(4, [], ['note'], head='e' * 64)); assert writer.receive_json()['type'] == 'ack'
        assert 'texts' not in PageStore(tmp_path).page(IDENTITY, 'b')[0]


def test_invalid_text_boxes_are_rejected(tmp_path):
    for bad in (text_box('t', '   '), text_box('t', 'x' * 5001), text_box('t', size='huge'), text_box('t', color='red'),
                text_box('t', width=30), text_box('t', x=900), text_box('t', code='yes'), text_box('t', extra=1)):
        with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
            hello(writer); recover(writer)
            writer.send_json(text_edit(1, [bad]))
            with pytest.raises(WebSocketDisconnect): writer.receive_json()
