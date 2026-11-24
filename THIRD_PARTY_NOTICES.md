# Third-party components

The LiveMitschrift project license is undecided. This does not change the licenses
of its dependencies. Keep upstream notices with redistributed assets and review
the complete resolved dependency inventory before the first public release.

## Principal runtime dependencies

| Component | License | Source |
| --- | --- | --- |
| Tauri and its JavaScript API | MIT OR Apache-2.0 | https://github.com/tauri-apps/tauri |
| PDF.js / pdfjs-dist | Apache-2.0 | https://github.com/mozilla/pdf.js |
| pdf-lib | MIT | https://github.com/Hopding/pdf-lib |
| uqr (QR codes in the desktop share dialog) | MIT | https://github.com/unjs/uqr |
| FastAPI | MIT | https://github.com/fastapi/fastapi |
| Uvicorn | BSD-3-Clause | https://github.com/Kludex/uvicorn |
| websockets | BSD-3-Clause | https://github.com/python-websockets/websockets |
| python-dotenv | BSD-3-Clause | https://github.com/theskumar/python-dotenv |
| pypdf | BSD-3-Clause | https://github.com/py-pdf/pypdf |
| rusqlite | MIT | https://github.com/rusqlite/rusqlite |
| SQLite | Public domain | https://sqlite.org/copyright.html |
| serde / serde_json | MIT OR Apache-2.0 | https://github.com/serde-rs |
| sha2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| getrandom | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| rfd | MIT | https://github.com/PolyMeilex/rfd |
| zip | MIT | https://github.com/zip-rs/zip2 |
| keyring | MIT OR Apache-2.0 | https://github.com/open-source-cooperative/keyring-rs |
| objc2, its framework bindings and block2 | MIT | https://github.com/madsmtm/objc2 |

This table is an overview, not a complete attribution file. Exact resolved versions
and transitive packages are recorded in `package-lock.json`,
`apps/desktop/src-tauri/Cargo.lock` and `backend/requirements.lock`.

The PDF asset-copy step retains PDF.js's license and the notices distributed with
its standard fonts, CMaps and WASM resources. Runtime npm license texts are also
copied into the viewer and desktop assets under `pdfjs/third-party/`; Python wheels
retain their `.dist-info` license files in the image. Generated GHCR releases
include an SBOM. Apple system frameworks and OS WebKit are supplied by macOS.

Docker runtime/base images and the separately deployed Caddy proxy have their own
upstream component notices. See the [Python image source](https://github.com/docker-library/python)
and [Caddy license](https://github.com/caddyserver/caddy/blob/master/LICENSE).
No external slide decks, fonts or private lecture content are committed; test PDFs
are generated from original fixture code.
