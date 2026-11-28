"""Exercise the bundled teaching workflow with disposable release data and a server."""
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
from pypdf import PdfReader

from test_support import BINARY, ROOT, start_server, stop, seed_database



def verify(path, expected):
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA user_version").fetchone() == (2,)
        assert json.loads(connection.execute("SELECT data FROM strokes WHERE id='seed-ink'").fetchone()[0]) == expected
        assert connection.execute("SELECT count(*) FROM topics").fetchone()[0] == 2
        assert connection.execute("SELECT count(*) FROM pages").fetchone()[0] == 3
        rows = connection.execute("SELECT background FROM pages WHERE background IS NOT NULL ORDER BY position").fetchall()
        assert [json.loads(row[0])["pageNumber"] for row in rows] == [1, 2]
        return connection.execute("SELECT id,page_id,position,data FROM strokes ORDER BY page_id,position").fetchall()


def main():
    fixture = ROOT / "tmp/pdfs/livemitschrift-two-pages.pdf"
    if not fixture.is_file():
        raise RuntimeError("Generate the existing PDF fixtures with scripts/create_pdf_test_slide.py first")
    with socket.socket() as address:
        address.bind(("127.0.0.1", 0))
        port = address.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="livemitschrift-workflow-smoke-") as temporary:
        directory = Path(temporary)
        database = directory / "livemitschrift.sqlite3"
        expected = seed_database(database)
        source = directory / "source.pdf"
        shutil.copyfile(fixture, source)
        environment = {**os.environ, "LIVEMITSCHRIFT_TEST_PUBLISHER_KEY": "d"*64, "LIVEMITSCHRIFT_STORAGE_SMOKE_DIR": temporary,
                       "LIVEMITSCHRIFT_WORKFLOW_PDF": str(source), "LIVEMITSCHRIFT_LIVE_SMOKE_SERVER": f"http://127.0.0.1:{port}"}
        server = app = None
        with (directory / "relay.log").open("w") as relay_log, (directory / "app.log").open("w") as app_log:
            try:
                # Local phase deliberately runs before any relay exists.
                result = subprocess.run([str(BINARY)], cwd=ROOT, env={**environment, "LIVEMITSCHRIFT_STORAGE_SMOKE_MODE": "workflow-local"}, capture_output=True, text=True, timeout=90)
                print(result.stdout, end="", flush=True)
                if result.returncode or not (directory / "local-passed").exists():
                    raise RuntimeError(f"Local workflow failed:\n{result.stdout}\n{result.stderr}")
                first = verify(database, expected)
                assert len(first) == 4
                source.unlink()  # The restart must rely on the copied resource.
                server = start_server(port, relay_log)
                app = subprocess.Popen([str(BINARY)], cwd=ROOT, env={**environment, "LIVEMITSCHRIFT_STORAGE_SMOKE_MODE": "workflow-live"}, stdout=app_log, stderr=app_log)
                deadline = time.monotonic() + 120
                stopped = restarted = False
                while app.poll() is None and time.monotonic() < deadline:
                    if not stopped and (directory / "stop-server").exists():
                        stop(server); stopped = True; (directory / "server-stopped").touch()
                        print("Workflow relay stopped; editor continues offline.", flush=True)
                    if stopped and not restarted and (directory / "offline-ink-ready").exists():
                        server = start_server(port, relay_log); restarted = True; (directory / "server-restarted").touch()
                    time.sleep(.05)
                if app.poll() is None or app.returncode or not (directory / "live-passed").exists():
                    raise RuntimeError("Live workflow failed or timed out")
                after = verify(database, expected)
                assert len(after) == 5
                exported = directory / 'student-export.pdf'
                assert len(PdfReader(exported).pages) == 5
                destination = ROOT / 'output/pdf/student-browser-export.pdf'
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(exported, destination)
                result = subprocess.run([str(BINARY)], cwd=ROOT, env={**environment, "LIVEMITSCHRIFT_STORAGE_SMOKE_MODE": "workflow-reopen"}, capture_output=True, text=True, timeout=45)
                if result.returncode or not (directory / "reopen-passed").exists():
                    raise RuntimeError(f"Workflow reopen failed:\n{result.stdout}\n{result.stderr}")
                assert verify(database, expected) == after
                locked = subprocess.run([str(BINARY)], cwd=ROOT, env={**environment,
                    "LIVEMITSCHRIFT_STORAGE_SMOKE_MODE": "workflow-keychain-locked",
                    "LIVEMITSCHRIFT_TEST_KEYCHAIN_LOCKED": "1"}, capture_output=True, text=True, timeout=45)
                if locked.returncode or not (directory / "keychain-passed").exists():
                    raise RuntimeError(f"Silent credential workflow failed:\n{locked.stdout}\n{locked.stderr}")
                assert verify(database, expected) == after
                print((directory / "app.log").read_text(), end="")
                print(result.stdout, end="")
                print(locked.stdout, end="")
                print("All native teaching-workflow checks passed.")
            except Exception:
                print((directory / "app.log").read_text())
                print((directory / "relay.log").read_text())
                raise
            finally:
                stop(app); stop(server)


if __name__ == "__main__":
    main()
