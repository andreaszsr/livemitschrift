# Architecture

LiveMitschrift is an offline-first macOS handwriting app for university teaching.
One lecturer owns and writes each notebook. Students read it through a
notebook-specific browser link and either browse on their own or follow the
lecturer's current page and scroll position. Students do not log in, and the
system does not support collaborative editing.

## Guiding constraints

- The app starts, draws and saves without a network connection. Local input
  never waits for network delivery.
- Strokes are stored in device-independent document coordinates. Alignment is
  therefore preserved at any zoom level.
- Original PDFs are stored separately from the handwriting on top of them.
- The desktop is the single, authoritative writer. A server snapshot never
  replaces unsynchronized local edits. This is why no CRDT is used.

## Components

| Directory | Responsibility |
| --- | --- |
| `packages/core` | Document coordinates, stroke geometry, tools, selection, wire data. No UI or network code. |
| `packages/pdf` | PDF rendering (pdf.js), thumbnails and vector PDF export |
| `packages/ui` | Shared toolbar, drawer and zoom UI |
| `apps/desktop` | Tauri v2 editor (TypeScript UI, Rust platform layer, AppKit tablet adapter, SQLite, outbox) |
| `frontend` | Read-only browser viewer |
| `backend` | FastAPI/WebSocket synchronization server with SQLite storage |
| `deploy` | Docker Compose, Caddy HTTPS proxy and configuration templates |

### Desktop

- **Input.** The macOS AppKit adapter reports the actual tablet identity,
  pressure, timestamps and button state to the WebView.
  - Real pen pressure is never inferred from mouse events.
  - The lower stylus button acts as a temporary eraser.
  - Pinch zoom can be locked.
  - Hold-to-straighten: when the pen rests at the end of a pen or marker stroke,
    the stroke becomes a straight line whose end follows the pen until pen-up.
    Readers already saw the freehand ink, so it is ended and removed with an
    edit; the line is then sent as an ordinary two-point stroke.
- **Rendering.** Strokes are smoothed when drawn; the stored points stay unchanged.
  - Page grid: a CSS background layer below the PDF and ink canvases, sized in
    container query units of the paper, so it zooms without redrawing. Grid
    settings (notebook default, topic and page overrides) are local
    preferences: never synchronized, published, backed up or exported.
- **Storage.** SQLite holds notebooks, topics and pages, including pages that
  grow downward as the lecturer writes.
  - Supported operations: whole-stroke erasing, undo/redo, lasso move,
    copy/cut/paste.
  - Local copies of imported PDFs.
  - PDF export and portable `.livemitschrift` backups.
  - PDF export writes into a folder the user chose; the folder (per notebook)
    and the last exported page (per topic) are local preferences. The Rust
    command accepts only a plain file name and asks before replacing a file.
- **Failure safety.** A failed save keeps the pending edits. A failed load never
  overwrites stored data. Quitting the app finalizes and flushes the current ink.
- **Outbox.** Each local edit and its outgoing operation are written in the same
  SQLite transaction. An operation stays in the outbox until the server
  acknowledges it. Retries are idempotent.
- **Credentials.** Publisher keys are optionally stored in the macOS Keychain.
  - Automatic startup reads only silently and never shows Keychain UI.
  - If approval is needed, publishing waits until the user explicitly loads the
    key or enters it.

### Synchronization protocol

1. The publisher authenticates in the first WebSocket frame and then sends
   `hello`. The hello message carries the notebook's private capability, its
   sequence number and its head.
2. The server compares sequence and head and requests any operations it is
   missing.
3. If the server has no base for the notebook, a staged recovery takes place.
   The publisher sends metadata and then each page, and the server commits the
   result atomically.
4. PDF assets are immutable and identified by their SHA-256 hash.
5. Readers receive the notebook structure and the content of the page they have
   selected, not every page.
   - Cached pages are checked against their revision before reuse.
   - Live ink, viewport and laser-pointer messages are transient. Only
     acknowledged, completed operations count as confirmed server data.
6. In Follow mode, the reader tracks the lecturer's page and the top of the
   visible document area, never the pen position. Each reader keeps its own zoom.
7. Readers can export the selected topic as a vector PDF.
   - The export loads complete confirmed pages one after another.
   - It does not change the reader's live subscription.
8. Readers can pin private text notes to a page position (document
   coordinates). Notes live only in the browser's `localStorage`, keyed by the
   notebook link, and in files the reader saves; the notes code never uses the
   network. Notes on pages the lecturer deleted are kept and listed separately.
   The reader's PDF export can add them as standard PDF Text annotations
   (UTF-16 contents) on the A4 slice of their position and, independently,
   as footnote-style numbers plus a printable text page per notebook page.

### Server

- **Process model.** One FastAPI process with one SQLite database. An exclusive
  lock on the data directory rejects a second process. In-memory socket state is
  intentionally not shared, so the server does not scale horizontally.
- **Accounts.** Lecturer accounts have personal, revocable keys. The configured
  operator key acts as the built-in `admin` account.
- **Ownership.** Each notebook has one owner. See [SECURITY.md](../SECURITY.md).
- **TLS.** TLS terminates at Caddy. Forwarded headers are trusted only from
  Caddy's fixed private address. The backend publishes no host port.
- **Limits.** Frame, transfer, page and PDF sizes are bounded, as are queues,
  connection counts, request rates and database size. The defaults are in
  [deployment](deployment.md#limits-and-monitoring).

## Operational assumptions

- The design target is one lecturer per notebook and up to about 50 simultaneous
  readers per lecture. Local tests with 50 readers through HTTPS passed; see
  [testing](testing.md#load-and-container-tests).
- Pausing sharing stops uploads but keeps confirmed notes readable. Withdrawing a
  notebook deletes its server content and permanently blocks its identity. Copies
  that readers have already downloaded cannot be revoked.
- Synchronization is not a backup. Keep independent backups and the original PDFs.
