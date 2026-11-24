import asyncio
import copy
import hashlib
import io
import json
import sqlite3

import pytest
from clients import AuthorizedClient as TestClient, connect
from starlette.websockets import WebSocketDisconnect
from pypdf import PdfReader, PdfWriter

from app.main import create_app
from app.page_store import PageStore
from app.notebook import Snapshot
from app.page_store import Recovery, metadata, MAX_FRAME_BYTES
from app.paged import Transfers
from app.room import ProtocolError
from fixtures import IDENTITY, SECRET, snapshot, stroke

HEAD = 'a' * 64
NEXT = 'b' * 64


def hello(writer, sequence=0, head=HEAD, first=None):
    writer.send_json({'type': 'hello', 'secret': SECRET, 'sequence': sequence, 'head': head, 'firstPending': first})
    return writer.receive_json()


def recover(writer, state=None, sequence=0, head=HEAD):
    state = state or snapshot()
    writer.send_json({'type': 'recover_begin', 'sequence': sequence, 'head': head, 'snapshot': metadata(state)})
    for topic in state['notebook']['topics']:
        for page in topic['pages']:
            writer.send_json({'type': 'recover_page', 'page': page})
            assert writer.receive_json() == {'type': 'page_staged', 'pageId': page['id']}
    writer.send_json({'type': 'recover_end'})
    assert writer.receive_json() == {'type': 'ack', 'sequence': sequence}


def edit(sequence=1, head=NEXT, page='a', inserted=None):
    return {'type': 'commit', 'sequence': sequence, 'head': head, 'change': {'type': 'edit', 'edit': {'id': f'edit-{sequence}', 'pageId': page, 'insert': inserted or [], 'remove': ['saved'] if page == 'a' else [], 'height': 6400}}}


def subscribe(viewer, page='a', request=1, revision=None):
    viewer.send_json({'type': 'subscribe', 'pageId': page, 'request': request, 'revision': revision})
    return receive_value(viewer)


def test_reconnect_only_missing_commits_and_selected_pages(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        with connect(client, '/ws/sync/v2/publish') as writer:
            assert hello(writer)['recover']
            recover(writer)
            with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as a, connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as b:
                structure = a.receive_json()
                assert structure['type'] == 'structure'
                assert all(not p['strokes'] for t in structure['notebook']['topics'] for p in t['pages'])
                a.receive_json(); b.receive_json(); b.receive_json()
                saved = subscribe(a); assert saved['page']['strokes'][0]['id'] == 'saved'
                assert subscribe(b, 'b')['page']['strokes'] == []
                writer.send_json(edit())
                assert writer.receive_json() == {'type': 'ack', 'sequence': 1}
                assert a.receive_json()['type'] == 'extent'
                assert a.receive_json()['type'] == 'edit'
                assert a.receive_json()['type'] == 'revision'
                assert b.receive_json()['type'] == 'extent'  # metadata only
                b.send_json({'type': 'ping'})
                assert b.receive_json() == {'type': 'pong'}  # no off-page ink
                assert subscribe(a, revision=NEXT)['type'] == 'page_current'
                assert subscribe(b, 'a', request=2)['page']['strokes'] == []
        with connect(client, '/ws/sync/v2/publish') as writer:
            answer = hello(writer, sequence=1, head=NEXT)
            assert answer['sequence'] == 1 and not answer['recover']
            # No checkpoint or page is needed; the next offline operation follows.
            writer.send_json(edit(2, 'c' * 64, 'b', [stroke('offline')]))
            assert writer.receive_json() == {'type': 'ack', 'sequence': 2}
    store = PageStore(tmp_path)
    assert store.page(IDENTITY, 'b')[0]['strokes'][0]['id'] == 'offline'
    with TestClient(create_app(tmp_path)) as client, connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
        assert viewer.receive_json()['type'] == 'structure'
        assert not viewer.receive_json()['connected']
        assert subscribe(viewer, 'b')['page']['strokes'][0]['id'] == 'offline'


def test_reader_export_is_complete_confirmed_and_bound_to_the_notebook(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        with connect(client, '/ws/sync/v2/publish') as writer:
            hello(writer); recover(writer)
            # Public read-capability requests need neither publisher credential.
            client.headers.pop('X-LiveMitschrift-Publisher-Key', None)
            full=client.get(f'/api/notebook/{IDENTITY}/page/a/export')
            assert full.status_code==200 and full.headers['cache-control']=='no-store'
            assert full.json()['strokes'][0]['points'][0]['y']==2000
            assert client.get(f'/api/notebook/{IDENTITY}/page/a/preview').json()['strokes']==[]
            assert client.get(f'/api/notebook/{"f"*64}/page/a/export').status_code==404
            assert client.get(f'/api/notebook/{IDENTITY}/page/missing/export').status_code==404
            # Missing pages must release their export slot; later reads still work.
            assert client.get(f'/api/notebook/{IDENTITY}/page/b/export').status_code==200
            before=PageStore(tmp_path).status(IDENTITY)
            writer.send_json(edit(inserted=[stroke('new')]))
            assert writer.receive_json()['type']=='ack'
            assert client.get(f'/api/notebook/{IDENTITY}/page/a/export').json()['strokes'][0]['id']=='new'
            assert PageStore(tmp_path).status(IDENTITY)['sequence']==before['sequence']+1


def test_cancelled_export_response_releases_the_large_page_slot(tmp_path):
    app=create_app(tmp_path)
    with TestClient(app) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
    endpoint=next(route.endpoint for route in app.routes if route.name=='export_page')
    async def scenario():
        async def receive(): return {'type':'http.disconnect'}
        async def disconnected(message): raise asyncio.CancelledError()
        response=await endpoint(IDENTITY,'a')
        with pytest.raises(asyncio.CancelledError):
            await response({'type':'http'},receive,disconnected)
        again=await asyncio.wait_for(endpoint(IDENTITY,'a'),1)
        messages=[]
        async def send(message): messages.append(message)
        await again({'type':'http'},receive,send)
        assert messages[0]['status']==200
        assert json.loads(messages[1]['body'])['strokes'][0]['id']=='saved'
    asyncio.run(scenario())


def test_server_behind_pruned_outbox_requires_atomic_recovery(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        with connect(client, '/ws/sync/v2/publish') as writer:
            hello(writer); recover(writer)
        with connect(client, '/ws/sync/v2/publish') as writer:
            assert hello(writer, sequence=4, head=NEXT, first=4)['recover']
            state = snapshot(); state['notebook']['title'] = 'Pending recovery'
            writer.send_json({'type': 'recover_begin', 'sequence': 4, 'head': NEXT, 'snapshot': metadata(state)})
            writer.send_json({'type': 'recover_page', 'page': state['notebook']['topics'][0]['pages'][0]})
            writer.receive_json()
            # Simulate loss during the second page. No partial state is durable.
        assert PageStore(tmp_path).status(IDENTITY) == {'sequence': 0, 'head': HEAD}
        assert PageStore(tmp_path).structure(IDENTITY)['notebook']['title'] != 'Pending recovery'
        with connect(client, '/ws/sync/v2/publish') as writer:
            assert hello(writer, sequence=4, head=NEXT)['recover']
            recover(writer, state, 4, NEXT)
    assert PageStore(tmp_path).status(IDENTITY)['sequence'] == 4


def test_idempotent_delta_disk_failure_and_conflicting_local_branch(tmp_path):
    store = PageStore(tmp_path); state = snapshot(); stage = Recovery()
    for topic in state['notebook']['topics']:
        for page in topic['pages']: stage.put(page)
    store.recover(IDENTITY, 0, HEAD, metadata(state), stage); stage.close()
    first = edit()
    assert store.delta(IDENTITY, 1, NEXT, first['change'])
    assert not store.delta(IDENTITY, 1, NEXT, first['change'])
    with pytest.raises(ProtocolError): store.delta(IDENTITY, 1, HEAD, first['change'])
    with store.connect() as db:
        db.execute("CREATE TRIGGER fail_commit BEFORE INSERT ON commits BEGIN SELECT RAISE(ABORT,'disk full'); END")
    with pytest.raises(sqlite3.Error): store.delta(IDENTITY, 2, 'c'*64, edit(2, page='b', inserted=[stroke('failed')])['change'])
    assert store.status(IDENTITY)['sequence'] == 1
    assert store.page(IDENTITY, 'b')[0]['strokes'] == []
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        writer.send_json({'type': 'hello', 'secret': SECRET, 'sequence': 1, 'head': HEAD, 'firstPending': None})
        with pytest.raises(WebSocketDisconnect) as error: writer.receive_json()
        assert error.value.code == 1008






def test_structure_commit_preserves_ink_and_viewers_cannot_write(tmp_path):
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        change = {'type': 'structure', 'notebook': metadata(snapshot())['notebook']}
        change['notebook']['title'] = 'Renamed'
        writer.send_json({'type': 'commit', 'sequence': 1, 'head': NEXT, 'change': change})
        assert writer.receive_json()['type'] == 'ack'
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
            assert viewer.receive_json()['notebook']['title'] == 'Renamed'
            viewer.receive_json()
            assert len(subscribe(viewer)['page']['strokes']) == 1
            viewer.send_json(edit(2))
            with pytest.raises(WebSocketDisconnect): viewer.receive_json()


def test_fragmentation_and_unknown_books_are_bounded(tmp_path):
    transfer = Transfers()
    assert transfer.receive({'type': 'transfer_start'}) is None
    with pytest.raises(ProtocolError): transfer.receive({'type': 'transfer_start'})
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/notebook/v2/view/' + 'f'*64) as viewer:
        with pytest.raises(WebSocketDisconnect): viewer.receive_json()


def test_single_pdf_page_preserves_crop_rotation_and_does_not_return_other_pages(tmp_path):
    writer = PdfWriter()
    writer.add_blank_page(width=600, height=800)
    page = writer.add_blank_page(width=900, height=700)
    page.cropbox.lower_left = (40, 60); page.cropbox.upper_right = (840, 660); page.rotate(90)
    output = io.BytesIO(); writer.write(output); data = output.getvalue(); asset = hashlib.sha256(data).hexdigest()
    state = snapshot(); state['notebook']['topics'][0]['pages'][1]['background'] = {'assetId': asset, 'name': 'slides.pdf', 'pageNumber': 2, 'width': 600, 'height': 800}
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as publisher:
        hello(publisher)
        assert client.post(f'/api/sync/pdf/{asset}', headers={'Authorization': f'Bearer {SECRET}'}, content=data).status_code == 200
        recover(publisher, state)
        response = client.get(f'/api/notebook/{IDENTITY}/pdf/{asset}/page/2')
        assert response.status_code == 200
        extracted = PdfReader(io.BytesIO(response.content)); assert len(extracted.pages) == 1
        assert extracted.pages[0].rotation == 90
        assert list(extracted.pages[0].cropbox) == [40, 60, 840, 660]
        assert client.get(f'/api/notebook/{IDENTITY}/pdf/{asset}/page/1').status_code == 404
        assert hello_assets_after_reconnect(client, asset)


def hello_assets_after_reconnect(client, asset):
    with connect(client, '/ws/sync/v2/publish') as writer:
        reply = hello(writer)
        return reply['assets'] == [asset] and not reply['recover']


def receive_value(socket):
    transfer = Transfers()
    while True:
        value = socket.receive_json()
        assert len(json.dumps(value, ensure_ascii=False).encode()) <= MAX_FRAME_BYTES
        result = transfer.receive(value)
        if result is not None:
            return result


def test_notebook_above_16mb_is_staged_pagewise_and_reader_gets_one_page(tmp_path):
    store = PageStore(tmp_path); stage = Recovery(); state = snapshot()
    pages = []; total = 0
    for index in range(40):
        page = copy.deepcopy(state['notebook']['topics'][0]['pages'][0]); page['id'] = f'large-{index}'
        line = stroke(f'ink-{index}'); line['points'] = [{'x': 123.456789, 'y': 1000.25, 'pressure': .527}] * 10000
        page['strokes'] = [line]; total += len(json.dumps(page).encode()); stage.put(page)
        page['strokes'] = []; pages.append(page)
    assert total > 16_000_000
    state['notebook']['topics'][0]['pages'] = pages; state['position'] = {'pageId': 'large-0', 'y': 0}
    store.recover(IDENTITY, 0, HEAD, state, stage); stage.close()
    with TestClient(create_app(tmp_path)) as client, connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
        structure = receive_value(viewer); assert len(structure['notebook']['topics'][0]['pages']) == 40
        assert len(json.dumps(structure)) < 20000
        viewer.receive_json(); viewer.send_json({'type': 'subscribe', 'pageId': 'large-39', 'request': 1})
        selected = receive_value(viewer)
        assert selected['page']['id'] == 'large-39'
        assert len(selected['page']['strokes'][0]['points']) == 10000
        assert len(json.dumps(selected)) < total / 30
        # An unauthenticated viewer cannot allocate an upload assembly buffer.
        viewer.send_json({'type': 'transfer_start'})
        with pytest.raises(WebSocketDisconnect): viewer.receive_json()


def test_off_page_extent_allows_follow_and_live_cache_revision_changes_on_commit(tmp_path):
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
            viewer.receive_json(); viewer.receive_json(); subscribe(viewer, 'a')
            writer.send_json({'type': 'extent', 'pageId': 'b', 'height': 9000})
            assert viewer.receive_json()['height'] == 9000
            writer.send_json({'type': 'viewport', 'position': {'pageId': 'b', 'y': 8000}})
            assert viewer.receive_json()['position']['y'] == 8000
            selected = subscribe(viewer, 'b', 2)
            old_revision = selected['revision']
            subscribe(viewer, 'a', 3)
            change = edit(page='b', inserted=[stroke('offline')]); change['change']['edit']['height'] = 9000
            writer.send_json(change); assert writer.receive_json()['type'] == 'ack'
            viewer.receive_json()  # extent only
            current = subscribe(viewer, 'b', 4, old_revision)
            assert current['type'] == 'page'
            assert current['page']['strokes'][0]['id'] == 'offline'


def test_input_resumes_after_structure_commit_and_later_ink_has_one_effect(tmp_path):
    with TestClient(create_app(tmp_path)) as client, connect(client, '/ws/sync/v2/publish') as writer:
        hello(writer); recover(writer)
        state = metadata(snapshot())
        extra = copy.deepcopy(state['notebook']['topics'][0]['pages'][1]); extra['id'] = 'new-page'
        state['notebook']['topics'][0]['pages'].append(extra)
        writer.send_json({'type': 'commit', 'sequence': 1, 'head': NEXT, 'change': {'type': 'structure', 'notebook': state['notebook']}})
        assert writer.receive_json()['type'] == 'ack'
        active = stroke('active'); active['complete'] = False; active['points'] = [{'x': 20, 'y': 7000, 'pressure': .2}, {'x': 30, 'y': 7050, 'pressure': .8}]
        writer.send_json({'type': 'extent', 'pageId': 'new-page', 'height': 8000})
        writer.send_json({'type': 'resume_ink', 'pageId': 'new-page', 'stroke': active})
        with connect(client, f'/ws/notebook/v2/view/{IDENTITY}') as viewer:
            viewer.receive_json(); viewer.receive_json()
            page = subscribe(viewer, 'new-page')['page']; assert len(page['strokes'][0]['points']) == 2
            writer.send_json({'type': 'ink', 'pageId': 'new-page', 'operation': {'type': 'stroke_end', 'stroke_id': 'active'}})
            assert viewer.receive_json()['operation']['type'] == 'stroke_end'
            assert viewer.receive_json()['type'] == 'revision'
            active['complete'] = True
            commit = edit(2, 'c'*64, 'new-page', [active]); commit['change']['edit']['height'] = 8000
            writer.send_json(commit); assert writer.receive_json()['type'] == 'ack'
            assert len(PageStore(tmp_path).page(IDENTITY, 'new-page')[0]['strokes']) == 1




def test_disconnect_waits_for_in_progress_sqlite_worker_before_staging_cleanup():
    import asyncio
    import threading
    from app.paged import durable_io
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    def write():
        entered.set()
        assert release.wait(2)
        finished.set()
    async def check():
        task = asyncio.create_task(durable_io(write))
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError): await task
        assert finished.is_set()
    asyncio.run(check())
