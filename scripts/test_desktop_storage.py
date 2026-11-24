"""Run the feature-gated macOS app against disposable SQLite databases."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile


def run(binary: Path, directory: Path, mode: str) -> list[dict]:
    result = subprocess.run(
        [str(binary)],
        env={**os.environ, "LIVEMITSCHRIFT_TEST_PUBLISHER_KEY": "d"*64, "LIVEMITSCHRIFT_STORAGE_SMOKE_DIR": str(directory), "LIVEMITSCHRIFT_STORAGE_SMOKE_MODE": mode},
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode or f"SMOKE_PASS {mode}" not in result.stdout:
        raise RuntimeError(f"{mode} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}")
    print(f"Passed: native {mode}", flush=True)
    return [json.loads(line.removeprefix("SMOKE_INPUT ")) for line in result.stdout.splitlines() if line.startswith("SMOKE_INPUT ")]


def strokes(path: Path) -> list[dict]:
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        return [json.loads(row[0]) for row in connection.execute("SELECT data FROM strokes ORDER BY position")]


def main() -> None:
    binary = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else Path(
        "apps/desktop/src-tauri/target/release/bundle/macos/LiveMitschrift.app/Contents/MacOS/livemitschrift-desktop"
    ).resolve()
    with tempfile.TemporaryDirectory(prefix="livemitschrift-persistence-smoke-") as temporary:
        directory = Path(temporary)
        database = directory / "livemitschrift.sqlite3"
        expected = run(binary, directory, "seed")[0]
        saved = strokes(database)
        assert len(saved) == 1 and saved[0]["complete"]
        assert saved[0]["points"] == expected, "Geometry/pressure changed during IPC or storage"
        run(binary, directory, "restore")
        assert strokes(database) == saved, "Reopening changed stored ink"
        with sqlite3.connect(database) as connection:
            connection.executescript("CREATE TRIGGER fail_write AFTER INSERT ON strokes BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;")
        run(binary, directory, "failure")
        recovered = strokes(database)
        assert len(recovered) == 2 and recovered[0] == saved[0]
        run(binary, directory, "quit")
        after_quit = strokes(database)
        assert len(after_quit) == 3 and after_quit[:2] == recovered
        with sqlite3.connect(database) as connection:
            connection.execute("PRAGMA user_version = 99")
        run(binary, directory, "blocked-load")
        assert strokes(database) == after_quit, "Failed load overwrote existing ink"
        with sqlite3.connect(database) as connection:
            assert connection.execute("PRAGMA user_version").fetchone() == (99,)
    print("All native persistence checks passed.")


if __name__ == "__main__":
    main()
