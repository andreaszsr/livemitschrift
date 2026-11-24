"""Native offline shutdown/restart recovery, independent of display refresh frames."""
import hashlib
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile

from test_support import BINARY, ROOT, start_server, stop
from test_support import seed_database


def main():
    with socket.socket() as address:
        address.bind(('127.0.0.1',0));port=address.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='livemitschrift-offline-sync-') as temporary:
        directory=Path(temporary);database=directory/'livemitschrift.sqlite3';seed_database(database)
        environment={**os.environ, "LIVEMITSCHRIFT_TEST_PUBLISHER_KEY": "d"*64,'LIVEMITSCHRIFT_STORAGE_SMOKE_DIR':temporary,'LIVEMITSCHRIFT_LIVE_SMOKE_SERVER':f'http://127.0.0.1:{port}'}
        def run(mode):
            result=subprocess.run([str(BINARY)],cwd=ROOT,env={**environment,'LIVEMITSCHRIFT_STORAGE_SMOKE_MODE':mode},capture_output=True,text=True,timeout=40)
            print(result.stdout,end='')
            if result.returncode:raise RuntimeError(result.stdout+'\n'+result.stderr)
        run('workflow-sync-seed')  # No server exists while writing or closing.
        with sqlite3.connect(database) as db:
            assert db.execute('SELECT count(*) FROM outbox').fetchone()[0]>0
            assert db.execute('SELECT count(*) FROM sync_targets WHERE enabled=1').fetchone()==(1,)
            before=db.execute('SELECT id,data FROM strokes ORDER BY id').fetchall();assert len(before)==2
            identity=hashlib.sha256(db.execute('SELECT secret FROM documents').fetchone()[0].encode()).hexdigest()
        server=None
        with (directory/'server.log').open('w') as log:
            try:
                server=start_server(port,log,publisher_key="e"*64);run('workflow-sync-denied')
                with sqlite3.connect(database) as db:
                    assert db.execute('SELECT count(*) FROM outbox').fetchone()[0]>0
                    assert db.execute('SELECT id,data FROM strokes ORDER BY id').fetchall()==before
                stop(server)
                server=start_server(port,log);run('workflow-sync-resume')
                assert (directory/'read-url').read_text()==f'http://127.0.0.1:{port}/notebook/{identity}'
                with sqlite3.connect(database) as db:
                    assert db.execute('SELECT count(*) FROM outbox').fetchone()==(0,)
                    assert db.execute('SELECT id,data FROM strokes ORDER BY id').fetchall()==before
                stop(server);server=start_server(port,log)
                check="""import json,sys
sys.path.insert(0, "scripts")
from websockets.sync.client import connect
from test_support import receive_value
with connect(sys.argv[1],max_size=16_000_000) as socket:
    state=receive_value(socket);status=receive_value(socket)
    for topic in state['notebook']['topics']:
        for index,page in enumerate(topic['pages']):
            socket.send(json.dumps({'type':'subscribe','pageId':page['id'],'request':index}))
            response=receive_value(socket);topic['pages'][index]=response['page']
    assert len(state['notebook']['topics'][0]['pages'][0]['strokes'])==2
    assert status=={'type':'source_status','connected':False}
    print('DURABLE_PASS server restart serves confirmed native offline ink with no desktop')
"""
                subprocess.run([str(ROOT/'.venv/bin/python'),'-c',check,f'ws://127.0.0.1:{port}/ws/notebook/v2/view/{identity}'],cwd=ROOT,check=True,timeout=15)
            finally:stop(server)


if __name__=='__main__':main()
