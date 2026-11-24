# Development

## Requirements

- Node.js 24 LTS and npm
- Python 3.14, for the backend and test scripts
- stable Rust, via `rust-toolchain.toml`
- Xcode Command Line Tools

The supported desktop target is Apple Silicon macOS 13+. The backend also runs on
Linux, both natively and in Docker.

`npm ci` installs exactly what `package-lock.json` lists. Rust builds use
`Cargo.lock`, and the Python runtime uses the hash-pinned
`backend/requirements.lock`.

## Setup

```sh
npm ci
python3.14 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r backend/requirements.lock
.venv/bin/python -m pip install -e './backend[test]'
```

## Run

```sh
npm run desktop:dev        # editor with hot reload (Vite + Tauri)
npm run desktop:build      # standalone .app under apps/desktop/src-tauri/target/release/bundle/macos/
```

To run a local sharing server, see [README](../README.md#run-a-local-sharing-server).

The development app is served from `http://127.0.0.1:1420`. A public server
rejects this origin. To publish to a remote server, use a built app.

### Keychain prompts during development

Local builds are ad-hoc signed. macOS ties Keychain access to the app's
signature, and each ad-hoc build counts as a new app, so a rebuilt app asks for
the stored publisher key again.

You may be able to keep one identity across rebuilds with a self-signed
code-signing certificate. Create it once in Keychain Access → Certificate
Assistant → Create a Certificate, with type "Code Signing". Then build with:

```sh
APPLE_SIGNING_IDENTITY="<certificate name>" npm run desktop:build
```

Whether this certificate keeps "Always Allow" across rebuilds is not yet
verified.

## Tests and audits

See [testing](testing.md) for:

- unit tests;
- isolated native app checks;
- load and container tests;
- the manual checklist.

Run the following before a pull request:

```sh
npm test
.venv/bin/python -m pytest -c backend/pyproject.toml backend/tests -q
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
python3 scripts/audit_sources.py
```

CI additionally runs:

```sh
npm audit --omit=dev --audit-level=high
.venv/bin/python -m pip_audit --disable-pip --no-deps -r backend/requirements.lock
gitleaks git . --redact=100 --no-banner
actionlint
python3 scripts/check_release.py
```

`scripts/audit_sources.py` checks tracked files and untracked files that are not
ignored. It refuses:

- secrets;
- databases;
- `.env` files;
- build output and toolchain paths.

Its `--export <empty-directory>` option creates a source copy you can review or
scan for secrets a second time.

## Python dependencies

`python3 scripts/lock_backend.py` checks that `backend/requirements.lock` matches
the direct pins in `backend/pyproject.toml`.

To refresh transitive dependencies on purpose:

1. Run `python scripts/lock_backend.py --update` with Python 3.14. It records the
   hashes of all published, non-yanked wheels.
2. Review the lock diff.
3. Reinstall with `--require-hashes`.
4. Run the tests and audits.
5. Rebuild the image for both architectures.
