# LiveMitschrift

Handwritten lecture notes that students can follow live in their browser.

LiveMitschrift is a macOS app for lecturers who write on a pen tablet. You can
write on blank pages or annotate slides imported as PDFs. If you want, a small
self-hosted server publishes each notebook as a read-only web page. Students open
the link or scan the QR code on the projector. They can follow your current page
or browse on their own, and they need no account or app.

- **Offline first.** The app starts, draws and saves locally with no server and
  no internet.
- **Built for teaching.** It has pressure-sensitive ink, a highlighter, a laser
  pointer, a lasso, PDF slides with extra writing space, and presenter-remote
  navigation.
- **Light server.** One FastAPI process with SQLite in Docker behind Caddy HTTPS.
  It is sized for a lecture hall of about 50 readers.

> **Status:** usable, pre-1.0. The server is published as a container image;
> there is no signed macOS download yet, so build the app from source (see
> below). The UI is currently **German only**; translations are on the
> [roadmap](ROADMAP.md).

## Features

### Desktop app (macOS, Apple Silicon)

- **Notebooks.** Notebooks contain topics, and topics contain pages. Pages grow
  downward as you write.
- **PDF import.** Multi-page PDFs up to 50 MB each.
- **Pen input.** Native AppKit tablet input with pressure, smoothed strokes,
  mouse fallback and pinch zoom with a zoom lock.
- **Tools.**
  - Pen and whole-stroke eraser; the lower stylus button erases temporarily.
  - Straight lines: rest the pen at the end of a stroke, then adjust the end
    point before lifting the pen.
  - Translucent highlighter with its own colors and widths.
  - Shapes: rectangle, circle (dragged from the centre), coordinate system
    (one quadrant or an axis cross) with ticks at the grid spacing. "Am Raster
    einrasten" snaps shapes and straight lines to the grid (5 mm without one).
  - Lasso to move, copy, cut, paste and delete strokes.
  - Laser pointer, which readers see too and which is never saved.
  - Undo and redo.
- **Page grid.** Squares, lines or dots (4–10 mm) behind PDFs and ink, only for
  the lecturer: readers and PDF exports never show it. A default per notebook
  (asked when creating one), changeable per topic and per page.
- **Lecture navigation.** ←/→ and Page Up/Down change pages, so presenter remotes
  and tablet ExpressKeys work. "Fit whole slide" zoom fits a slide to the screen.
- **Writing bar.** The bar can be configured, floating or docked. A floating bar
  turns vertical at the left or right window edge.
- **Organizing.** Notebooks and topics can be renamed and deleted, also by
  right-click. Topics are reordered by dragging.
- **Export and backup.** PDF export of a topic into a remembered folder per
  notebook (for example a Nextcloud folder), named `YYYY-MM-DD_topic_notebook`
  by default so files sort by date. The page range defaults to the
  pages written since the previous export. Portable `.livemitschrift` backups.

### Sharing

- **One link per notebook.** Each notebook gets its own read-only link. The share
  dialog copies it and shows a large QR code for the projector.
- **Browser viewer.**
  - Students can follow the lecturer's page and scroll position, or navigate on
    their own.
  - On phones, swipe changes pages.
  - A status badge shows Live, "lecturer offline" or "no connection".
  - The viewer reconnects automatically.
  - Students can pin private text notes to any spot of a page. Notes stay in
    their browser only (no account, nothing sent to the server) and can be
    saved to and loaded from a file. The PDF download can include them as PDF
    comments (sticky notes), optionally also as printable text.
- **PDF download.** Students can download the current topic as a PDF, including
  the slides and the confirmed ink.
- **Reliable sync.** Changes go through a transactional local outbox. Notes stay
  readable after the app closes.
- **Several lecturers per server.** Each lecturer has a personal, revocable key,
  and each notebook has one owner.
- **Privacy defaults.** No cookies and no tracking. Client IPs are truncated in
  logs, search engines are kept out with `noindex` and `robots.txt`, and an
  optional privacy page can be shown.

## Install

### Desktop app

Until signed downloads exist, build the app yourself on a Mac with Apple
Silicon. The requirements are listed in [development](docs/development.md#requirements).

```sh
npm ci
npm run desktop:build
open apps/desktop/src-tauri/target/release/bundle/macos/LiveMitschrift.app
```

The app works fully offline. Sharing is optional.

### Server

The server runs with Docker Compose. Caddy obtains HTTPS certificates
automatically, and only ports 80/443 are exposed. You need:

- a small Linux VPS (1–2 vCPU and 2 GB RAM are enough);
- a domain name.

```sh
git clone --branch v0.2.0 https://github.com/andreaszsr/livemitschrift.git livemitschrift-src && cd livemitschrift-src
python3 scripts/prepare_deployment.py /opt/livemitschrift
cd /opt/livemitschrift
# edit .env: DOMAIN, ACME_EMAIL (LIVEMITSCHRIFT_IMAGE=ghcr.io/andreaszsr/livemitschrift:0.2.0)
docker compose pull
docker compose up -d --wait
```

The [deployment guide](docs/deployment.md) covers:

- building the image yourself;
- lecturer accounts;
- host hardening;
- backups and restore;
- updates;
- an optional script to start and stop the server on demand.

Run exactly one backend process; workers and replicas are not supported.

### Run a local sharing server

For trying out sharing on one Mac:

```sh
python3.14 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r backend/requirements.lock
npm run build --workspace livemitschrift-frontend
.venv/bin/python scripts/configure_server.py      # creates backend/.env once
PYTHONPATH=backend .venv/bin/python -m app.server
```

Then, in the app:

1. Open the share dialog, "Teilen".
2. Enter `http://127.0.0.1:8000` and the publisher key from `backend/.env`.
3. Turn on "Synchronisieren und live teilen".
4. Open the reader link with "Browseransicht öffnen".

Plain HTTP is accepted only on loopback. Remote servers require HTTPS.

## Using it

- **Writing.** The writing bar has page navigation, undo/redo, pen, eraser,
  highlighter, lasso, laser pointer, grid, shapes, snapping and your color and
  width favorites.
  Keyboard shortcuts: P pen, E eraser, H highlighter, S lasso, L laser,
  F fullscreen.
- **Notebooks.** The drawer button opens notebooks and topics. The app reopens
  where you left off; notebooks and topics continue on the page viewed last.
- **Lecture tools.** The panel button opens PDF import, new topic, zoom, sharing,
  QR code and export.
- **Settings.** "Einstellungen …" holds backups, notebook management, colors and
  widths, the toolbar layout and a pen test.
- **Help.** Hover over any control for a short explanation.
- **Publisher key.** The key can be remembered in the macOS Keychain. Startup
  never shows a Keychain prompt. If macOS needs approval, the app stays local
  until you click the connection icon and choose "Gespeicherten Schlüssel laden".

See [SECURITY.md](SECURITY.md) for how keys, links and withdrawal work.

## Documentation

- [Architecture](docs/architecture.md): components, sync protocol, design constraints
- [Deployment](docs/deployment.md): server installation and operations
- [Development](docs/development.md): setup, builds, audits
- [Testing](docs/testing.md): automated, native and manual checks
- [Releasing](docs/releasing.md): versioning, CI and signing
- [Privacy notice template](docs/privacy-notice-template.md) (German)
- [Roadmap](ROADMAP.md) and [Contributing](CONTRIBUTING.md)

## How this project is made

LiveMitschrift is developed by andreaszsr, who sets the requirements, design
decisions and priorities and tests the app in real lectures. Claude Code
(Anthropic) writes almost all of the code, and no one reviews it line by line.
Quality comes from three sources:

- automated tests: unit, integration, native app and 50-reader load tests (see
  [testing](docs/testing.md));
- security audits in CI;
- practical use in teaching.

Please keep this in mind when you evaluate the project, and report problems you
find.

## License

[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

If you run a modified server for others, you must offer them its source code.
Third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
