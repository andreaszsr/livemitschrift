"""Isolated backend/native test support. Never reads the production .env."""
import os
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen
from urllib.error import URLError

ROOT=Path(__file__).resolve().parents[1]
BINARY=ROOT/'apps/desktop/src-tauri/target/release/bundle/macos/LiveMitschrift.app/Contents/MacOS/livemitschrift-desktop'

def receive_value(socket):
    """Decode the same bounded transfer envelope used by the viewer."""
    import json
    first = json.loads(socket.recv())
    if first['type'] != 'transfer_start':
        return first
    chunks = []
    while True:
        chunk = json.loads(socket.recv())
        if chunk['type'] == 'transfer_end':
            break
        assert chunk['type'] == 'transfer_chunk'
        chunks.append(chunk['text'])
    return json.loads(''.join(chunks))

def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def start_server(port, log, publisher_key="d"*64):
    process = subprocess.Popen([
        str(ROOT / ".venv/bin/python"), "-m", "uvicorn", "app.main:create_app", "--factory", "--app-dir", "backend",
        "--ws-max-size", "256000", "--no-access-log", "--no-server-header", "--host", "127.0.0.1", "--port", str(port), "--timeout-graceful-shutdown", "2",
    ], cwd=ROOT, stdout=log, stderr=log, env={**os.environ, "LIVEMITSCHRIFT_TEST_PUBLISHER_KEY": "d"*64,"LIVEMITSCHRIFT_SERVER_DIR":str(Path(log.name).parent / "server"),"LIVEMITSCHRIFT_PUBLISHER_KEY":publisher_key,"LIVEMITSCHRIFT_PUBLIC_URL":"","LIVEMITSCHRIFT_PUBLISHER_KEY_FILE":""})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5) as response:
                if response.status == 200:
                    return process
        except (URLError, TimeoutError):
            if process.poll() is not None:
                raise RuntimeError("Relay server exited during startup")
            time.sleep(0.05)
    stop(process)
    raise RuntimeError("Relay server failed to start")



def seed_database(path):
    import sqlite3,json
    stroke={"id":"seed-ink","color":"#243147","width":3.5,"complete":True,"order":0,"points":[{"x":100,"y":200,"pressure":.12}]}
    with sqlite3.connect(path) as db:
        db.executescript((ROOT/'apps/desktop/src-tauri/src/schema.sql').read_text())
        db.execute("INSERT INTO documents(id,title,secret,sync_head) VALUES('local-document','Meine Notizen',?,?)",('7'*64,'a'*64))
        db.execute("INSERT INTO topics VALUES('local-topic','local-document','Mitschrift',0)")
        db.execute("INSERT INTO pages(id,document_id,width,height,topic_id,next_order) VALUES('local-page','local-document',1200,1600,'local-topic',1)")
        db.execute("INSERT INTO strokes VALUES('seed-ink','local-page',0,?)",(json.dumps(stroke),))
        db.execute('PRAGMA user_version=1')  # a release 0.2 database; the app migrates it to 2
    return stroke
