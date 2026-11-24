"""Bundled export/backup/restore and durable server reads after the editor exits."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import zipfile

from test_support import BINARY, ROOT, start_server, stop
from test_support import seed_database


def main():
    with socket.socket() as address:
        address.bind(('127.0.0.1',0));port=address.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='livemitschrift-library-') as temporary:
        directory=Path(temporary);seed_database(directory/'livemitschrift.sqlite3')
        environment={**os.environ, "LIVEMITSCHRIFT_TEST_PUBLISHER_KEY": "d"*64,'LIVEMITSCHRIFT_STORAGE_SMOKE_DIR':temporary,'LIVEMITSCHRIFT_STORAGE_SMOKE_MODE':'workflow-library',
                     'LIVEMITSCHRIFT_EXPORT_TEST_DIR':temporary,'LIVEMITSCHRIFT_WORKFLOW_PDF':str(ROOT/'tmp/pdfs/livemitschrift-two-pages.pdf'),
                     'LIVEMITSCHRIFT_LIVE_SMOKE_SERVER':f'http://127.0.0.1:{port}'}
        server=None
        with (directory/'server.log').open('w') as log:
            try:
                server=start_server(port,log)
                result=subprocess.run([str(BINARY)],cwd=ROOT,env=environment,capture_output=True,text=True,timeout=120)
                print(result.stdout,end='')
                if result.returncode or not (directory/'library-passed').is_file():
                    raise RuntimeError(f'Native library test failed:\n{result.stdout}\n{result.stderr}\n{(directory/"server.log").read_text()}')
                assert (directory/'export.pdf').read_bytes().startswith(b'%PDF-')
                with zipfile.ZipFile(directory/'export.livemitschrift') as archive:
                    manifest=json.loads(archive.read('notebook.json'));assert manifest['version']==1
                    assert manifest['notebook']['title']=='Backup lecture'
                    assert len(manifest['notebook']['topics'])==2
                    assert len(archive.namelist())==2
                with sqlite3.connect(directory/'livemitschrift.sqlite3') as db:
                    assert db.execute('PRAGMA integrity_check').fetchone()==('ok',)
                    assert db.execute('SELECT count(*) FROM documents').fetchone()==(2,)
                    assert db.execute('SELECT count(DISTINCT secret) FROM documents').fetchone()==(2,)
                    shared=db.execute('SELECT document_id FROM sync_targets WHERE enabled=1').fetchone()[0]
                    assert db.execute('SELECT count(*) FROM outbox WHERE document_id=?',(shared,)).fetchone()==(0,)
                # Restart only the server. No desktop process exists at this point.
                stop(server);server=start_server(port,log)
                identity=(directory/'read-url').read_text().rsplit('/',1)[1]
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
    assert state['notebook']['title']=='Backup lecture'
    assert sum(len(p['strokes']) for t in state['notebook']['topics'] for p in t['pages'])==4
    assert status=={'type':'source_status','connected':False}
    print('LIBRARY_PASS server restart retains restored PDF notebook without desktop')
"""
                subprocess.run([str(ROOT/'.venv/bin/python'),'-c',check,f'ws://127.0.0.1:{port}/ws/notebook/v2/view/{identity}'],cwd=ROOT,check=True,timeout=15)
                output=ROOT/'output/pdf/native-topic-export.pdf';output.parent.mkdir(parents=True,exist_ok=True);output.write_bytes((directory/'export.pdf').read_bytes())
            finally:
                stop(server)


if __name__=='__main__':main()
