# Contributing

Bug reports, ideas and pull requests are welcome.

## Before you start

- **Larger changes.** For a new feature, a protocol or storage change, or a new
  dependency, open an issue first and describe the idea. LiveMitschrift is
  deliberately small. Read the principles in [AGENTS.md](AGENTS.md) and the
  [architecture](docs/architecture.md).
- **Security issues.** Report them privately; see [SECURITY.md](SECURITY.md).

## Setup and checks

Setup is described in [docs/development.md](docs/development.md). Run these
before opening a pull request:

```sh
npm test
.venv/bin/python -m pytest -c backend/pyproject.toml backend/tests -q
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
python3 scripts/audit_sources.py
```

For changes to pen input, rendering or the viewer, also go through the relevant
parts of the [manual checklist](docs/testing.md#manual-checklist). In the pull
request, say which checks you ran.

## Guidelines

- **Scope.** Keep pull requests small and focused on one change. Do not reformat
  or upgrade unrelated code.
- **Tests.** Add tests for logic that can be tested without hardware.
- **Language.** Code, comments, docs and commit messages are in English. UI
  strings are currently German; keep them consistent.
- **Data and secrets.** Never commit credentials, `.env` files, databases or
  build output.
- **Documentation.** Update the docs when behavior, commands or configuration
  change.

## License

LiveMitschrift is licensed under AGPL-3.0-only. By submitting a contribution, you
agree that it is licensed under the same terms.
