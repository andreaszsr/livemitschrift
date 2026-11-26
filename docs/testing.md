# Testing

The project has three kinds of tests:

- **Automated unit and integration tests** run in CI. See [Automated tests](#automated-tests).
- **Isolated native checks** drive the real macOS app with synthetic input. See [Isolated native checks](#isolated-native-checks-macos).
- **Manual checks** cover what needs real hardware: a Wacom tablet, a projector or phones. See [Manual checklist](#manual-checklist).

## Automated tests

```sh
npm test                                                     # TypeScript: core, ui, pdf, desktop, viewer
.venv/bin/python -m pytest -c backend/pyproject.toml backend/tests -q
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

On some setups `cargo` is not on `PATH`. In that case use
`sh scripts/with-tools.sh cargo …`, which finds a project-local toolchain under
`.tools/`.

Add tests for logic that can be checked without hardware. This includes:

- coordinate transforms;
- stroke data and serialization;
- tools, selection and undo/redo;
- synchronization messages;
- persistence.

## Isolated native checks (macOS)

These scripts open real GUI windows, so run them from a logged-in desktop
session. They use temporary SQLite databases, fixture credentials and their own
loopback server.

**Never point them at real notebook data.** **Never distribute a build that has
test features enabled.**

```sh
.venv/bin/python -m pip install reportlab==5.1.0
.venv/bin/python scripts/create_pdf_test_slide.py
npm run icons --workspace @livemitschrift/desktop
npm run tauri --workspace @livemitschrift/desktop -- build --features workflow-smoke-test --bundles app
.venv/bin/python scripts/test_desktop_storage.py    # persistence, failed write/retry, quit, blocked load
.venv/bin/python scripts/test_desktop_workflow.py   # PDF pages, ink, eraser/undo, zoom, offline, Follow viewer
.venv/bin/python scripts/test_desktop_sync.py       # server restart, replay, late join
.venv/bin/python scripts/test_desktop_library.py    # PDF export, backup/restore, rename, publishing
.venv/bin/python scripts/test_browser_export.py     # browser topic export (headless Chrome)
```

The library check writes `output/pdf/native-topic-export.pdf`. Look at the
rendered pages yourself to confirm the result.

Afterwards, rebuild normally with `npm run desktop:build`. Normal builds reject
test-data overrides before they open a database. Do not run Vite or npm builds in
parallel with a native bundle build, because they share generated assets.

## Load and container tests

The container test builds and installs the real image behind Caddy, using actual
HTTPS/WSS and a test-only CA. It runs 50 readers and one writer, with live ink,
page changes, PDF requests and a simultaneous reconnect burst. It then compares
each reader's geometry with the stored data and checks the installation's
hardening:

- foreign Host and Origin values are rejected;
- the backend runs as a non-root user with a read-only root filesystem;
- the backend port is private;
- backup and restore work.

```sh
docker build -t livemitschrift:test .
.venv/bin/python scripts/create_pdf_test_slide.py
.venv/bin/python scripts/test_container.py --image livemitschrift:test --viewers 50 --duration 30
```

For longer synthetic workloads there is a loopback runner without TLS. It starts
its own isolated server:

```sh
.venv/bin/python scripts/load_test_sync.py --viewers 50 --duration 60
.venv/bin/python scripts/create_load_test_pdf.py    # optional large image PDF
.venv/bin/python scripts/load_test_sync.py --viewers 50 --duration 60 --scenario follow --pdf tmp/pdfs/livemitschrift-load-test.pdf
```

Both tests write JSON reports to the ignored `output/load-test/` directory. They
measure protocol delivery over real sockets. They do not measure browser
rendering, pen-to-screen latency or a real WAN.

## Manual checklist

Run these checks with a release build and an isolated or disposable notebook.
Button names are quoted as they appear in the German UI.

### Pen input (Wacom or another tablet)

- **Input source.** The pen test in "Einstellungen …" reports **Stift (AppKit)**
  and a varying raw pressure value. If it shows "Maus", the tablet metadata is
  missing.
- **Strokes.** Line width follows pressure. Slow strokes, fast strokes and small
  dots are continuous. Ink is aligned with a stationary pen tip, also after
  resizing the window, zooming and scrolling.
- **Straight lines.** Drawing a stroke and resting the pen turns it into a
  straight line; its end follows the pen until it is lifted. Short pauses
  during normal writing do not trigger it. Readers see the line, not the
  freehand stroke.
- **Stylus buttons.** The lower stylus button erases temporarily. The eraser end
  erases.
- **Interruptions.** Lifting the pen outside the page or moving the pointer
  away mid-stroke ends the stroke cleanly.
- **Offline start.** The app starts and draws with no server and no internet.

### Export

- **PDF export.** The first export asks for a folder (try a Nextcloud folder).
  The next export of the notebook reuses it, and the range starts after the
  last exported page and ends at the visible page. Ranges like `2-5,7` export
  only those pages. An existing file is replaced only after confirmation.

### Lecture tools

- **PDF import.** Import a 15–50 MB PDF. Import, upload and server rendering
  work.
- **Page navigation.** ←/→ and Page Up/Down change pages, also from a presenter
  remote or a mapped ExpressKey. Arrow keys inside text inputs still edit text.
- **Highlighter (H).** The highlighter is translucent and has constant width. No
  darker dots appear after lifting the pen. It appears translucent in the PDF
  export and in thumbnails.
- **Lasso (S).** Select strokes by circling them and drag the selection. ⌘C, ⌘X
  and ⌘V work, also onto another page. Delete removes the selection. Undo
  reverts each step. Readers see the result.
- **Laser pointer (L).** It shows a dot with a short trail and fades out. It
  creates no stroke and no undo entry, is gone after reload, and readers on the
  same page see it.
- **Fit to slide.** "Ganze Folie zeigen" fits 4:3 and 16:9 slides on a projector.
- **Writing bar.** Dragged to the left or right edge, the floating writing bar
  turns vertical. Dragged to the top or bottom edge, it turns horizontal again.
  The drawer stays usable in both orientations.
- **Notebooks and topics.** Deleting and renaming work, both in the management
  dialog and by right-click. Dragging a topic reorders it.
- **Sharing.** "Link kopieren" works. The QR code can be scanned from the back of
  a lecture hall.

### Browser viewer

- **Status badge.** It shows Live, "Dozent offline" (app closed) and "Keine
  Verbindung" (server stopped), and recovers automatically.
- **Follow.** Follow tracks page changes and scrolling. Fast slide flipping keeps
  all readers connected. Manual navigation pauses Follow.
- **Phones (about 400 px wide).** The navigation buttons are visible. A
  horizontal swipe changes pages. A tap does not stop Follow, but vertical
  scrolling does. After the phone was locked for several minutes, the view
  reconnects.
- **Topic export.** "Aktuelles Thema als PDF exportieren" contains all pages,
  the PDF backgrounds and the confirmed ink.
- **Private notes (phone and laptop).** "Notiz setzen", then a tap places a
  note at that spot; a swipe still changes pages. Markers stay in place when
  zooming. Notes survive a reload, "Meine Notizen" lists them and saves/loads
  a file.
