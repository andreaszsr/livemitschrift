# AGENTS.md — LiveMitschrift

Guidelines for contributors and coding agents. Human contributors should also
read [CONTRIBUTING.md](CONTRIBUTING.md).

## Project Overview

LiveMitschrift is a lightweight, offline-first desktop note-taking application with
optional real-time synchronization and a read-only web viewer.

The primary use case is university teaching: an instructor writes on a Wacom tablet, optionally annotating PDF documents, while students follow the notes live in their browsers.

Students can navigate independently or follow the instructor's current position.

Read [docs/architecture.md](docs/architecture.md) for the architecture and
[ROADMAP.md](ROADMAP.md) for planned work.

## Development Principles

### 1. Keep It Simple

- Prefer simple, readable solutions over elaborate abstractions.
- Avoid unnecessary dependencies, frameworks, and design patterns.
- Do not implement features that are not currently required.
- Prefer standard browser APIs when practical.
- Optimize for maintainability rather than cleverness.

### 2. Work Incrementally

- Implement one well-defined feature at a time.
- Keep changes small and easy to review.
- Do not rewrite working components without a clear reason.
- Preserve existing functionality when adding new features.

Before substantial changes, briefly explain the proposed approach and any relevant trade-offs.

### 3. Code Quality

- Use TypeScript for shared drawing code and frontend code, Rust for the small
  Tauri platform layer, and Python for the synchronization server.
- Use descriptive names for variables, functions, and classes.
- Keep functions focused and reasonably short.
- Add comments explaining non-obvious algorithms, mathematical operations, coordinate transformations, and synchronization behavior.
- Avoid comments that merely repeat what the code already expresses.
- Use type annotations consistently.
- Handle errors explicitly.

### 4. Architecture

Maintain clear separation between:

- Document and notebook data
- Rendering
- Pointer and pen input
- Drawing tools
- Network synchronization
- Persistent storage
- User interface

The desktop editor must start and accept input without a server or network.
Keep Tauri-specific APIs outside `packages/core`. The core may use standard Canvas
and Pointer Events APIs, but must not depend on application UI or networking.

Do not introduce large frontend frameworks unless there is a demonstrated need.

Keep the drawing engine independent of the networking layer.

Use device-independent document coordinates. Screen coordinates must never be stored as document coordinates without an explicit transformation.

PDF backgrounds and handwritten annotations must remain separate.

### 5. Real-Time Synchronization

- Use WebSockets for incremental live updates.
- Transmit drawing operations rather than screenshots.
- Keep network messages small.
- Ensure the student view remains read-only.
- Support state synchronization when a client connects or reconnects.
- The desktop's local document is authoritative for its single writer. Never
  replace unsynchronized local changes with a server snapshot.
- When durable synchronization is introduced, persist the document change and
  its outgoing operation in the same local transaction. Retain operations until
  acknowledged; retries must be idempotent.
- Keep the instructor's viewport independent of each student's viewport, except when follow mode is enabled.
- Prefer a single-writer architecture initially.

Do not introduce distributed synchronization frameworks or CRDTs unless concurrent editing becomes a requirement.

### 6. Pen Input and Rendering

- Use Pointer Events where the WebView exposes real tablet metadata. The macOS
  desktop uses an app-local AppKit adapter for pressure and device identity;
  keep that platform layer outside the shared core. Never infer real pen
  pressure from a mouse event's fixed fallback value.
- Support pressure information when available.
- Ensure smooth, low-latency local rendering.
- Preserve stroke geometry independently of zoom and viewport dimensions.
- Avoid rerendering an entire document for every pointer movement.
- Handle pointer cancellation and interrupted strokes.

The instructor's drawing must not depend on network latency.

### 7. Testing

Add automated tests for logic that can be tested independently, especially:

- Coordinate transformations
- Stroke data structures and serialization
- Drawing operations
- Undo/redo behavior
- Synchronization messages
- Persistence

Use manual browser tests where hardware-specific behavior, particularly Wacom input, cannot reasonably be automated.

Run relevant existing tests after making changes. Report tests that could not be executed.

### 8. Dependencies

- Prefer established, actively maintained libraries.
- Add dependencies only when they provide clear value.
- Avoid overlapping libraries that solve the same problem.
- Keep dependencies and their versions documented.
- Do not upgrade unrelated dependencies during feature work.

### 9. Documentation

Keep documentation concise and accurate.

- `README.md`: Overview, installation, usage.
- `docs/architecture.md`: Architecture and design constraints.
- `ROADMAP.md`: Planned work and non-goals.
- `docs/`: Development, testing, deployment and releasing.
- `AGENTS.md`: Development instructions for coding agents.

Update documentation when behavior, architecture, commands, or important design decisions change.

### 10. Git and Change Management

- Keep changes logically grouped.
- Do not commit generated files, local databases, virtual environments, or build artifacts.
- Maintain an appropriate `.gitignore`.
- Do not delete or overwrite user data without explicit authorization.
- Agents: do not create commits unless requested.
- Do not modify unrelated code.

### 11. Communication

- Write source code identifiers, technical documentation, commit messages and code comments in English.
- The user interface is currently German only. Keep new UI strings consistent with it until translations exist (see `ROADMAP.md`).
- Explain important technical decisions briefly and precisely.
- Identify assumptions and unresolved questions.
- Do not claim that functionality has been tested unless tests were actually performed.
- Prefer working, testable implementations over lengthy theoretical descriptions.

## Invariants

- Preserve the AppKit pen input, rendering, offline SQLite editing, PDFs,
  erasing/undo, export/backup and the pagewise durable synchronization.
- Keep one supported publishing/viewer protocol and one backend process.
- Authenticate every write, validate WebSocket origins/hosts and proxy trust,
  bound public connections/rates/uploads/resources and keep secrets out of logs.
- Docker runs the backend as an unprivileged user with persistent data, a separate
  publisher secret and a private backend port behind HTTPS/WSS.
- Test native builds with isolated databases. Never overwrite data after load
  errors or claim pending ink is saved. Keep outbox changes atomic and acknowledged.
- Publishing credentials and notebook databases must never enter source control,
  release artifacts or Docker build contexts. Never move credentials to SQLite or
  plaintext as a workaround for Keychain prompts.
- macOS is the supported desktop platform. Keep portable modules separated,
  without adding Windows/Linux release work.

## Definition of Done

A feature is complete when:

- It performs the intended function.
- Existing behavior remains functional.
- Relevant tests pass.
- Error cases are handled appropriately.
- The implementation remains understandable.
- Documentation is updated where necessary.

Prioritize functional correctness, responsiveness and a clean foundation over visual polish.
