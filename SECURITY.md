# Security model

LiveMitschrift supports one trusted operator, several lecturer accounts and a
single authoritative writer per notebook. This is a small self-hosted service; only lecturers have accounts.

- A random 256-bit publisher key authorizes server writes. It is supplied in the
  first authenticated WebSocket frame or an HTTP header, never a URL. Publishing
  also requires the notebook's private capability. The browser receives neither.
- Keys are either the configured operator key (built-in account `admin`) or
  personal keys per lecturer, created with `python -m app.users` on the host.
  Personal keys are stored only as SHA-256 hashes, can be revoked individually
  and stop working when their account is disabled; a running session ends at its
  next durable write. Failed authentications are throttled per client address.
- Each notebook belongs to the account that first published it. Other accounts,
  including administrators, cannot publish into it; ownership changes only via
  `app.users transfer`. Owners may withdraw their notebooks, administrators any.
  A per-account notebook quota applies (`LIVEMITSCHRIFT_MAX_NOTEBOOKS_PER_USER`).
- A notebook URL grants read access to every topic/page and referenced PDF in that
  notebook. Anyone possessing the link can read and share it. There is no student
  login, expiry or per-page access restriction. Do not use this model for content
  requiring individual authentication.
- Remote publishing requires HTTPS/WSS. The provided Compose stack publishes only
  Caddy and trusts forwarded headers exclusively from its fixed private address.
  Host/Origin checks also apply to WebSockets. Missing Origin is accepted for
  native clients; capabilities remain mandatory for writes.
- Reader sockets accept only bounded subscription/ping messages. A reader over its
  request budget is closed with 1013 and reconnects with backoff. Publisher
  authentication precedes notebook content. Frame/transfer/page/PDF sizes, queues,
  connection counts, request rates and database growth are bounded. These controls
  reduce resource abuse; they do not provide DDoS protection.
- The container runs the backend as an unprivileged user with a read-only root,
  dropped capabilities and no host port. SQLite/PDF data lives in its volume.
  Public API schema/docs and legacy browser editing endpoints are disabled.
- Responses set a restrictive CSP, anti-framing, no-sniff and no-referrer headers;
  HTTPS deployments add HSTS. PDF JavaScript evaluation is disabled in rendering.
  Keep dependencies and the base/proxy images updated.

The laser pointer is a transient publisher message (page and x/y only). The
server validates and forwards it to readers of that page; it is never stored.

## Keys, links and revocation

The optional remembered Mac publisher key resides in the operating system
Keychain. Desktop notebook capabilities and notes are local SQLite data, not
application-level encrypted storage. Protect the Mac account, server filesystem,
Docker access, backups and Apple/GitHub release credentials.

Automatic credential reads suppress Keychain interaction. If the store cannot
provide a key silently, the app pauses automatic publishing and asks the user to
load the saved key explicitly or enter it. On macOS, credential operations are
serialized while the scoped Keychain interaction guard is active; explicit loads,
saves and deletion retain normal OS authorization. No credentials are moved to
SQLite or plaintext as a workaround for approval prompts.

Pausing desktop sharing stops uploads but leaves confirmed notes readable.
Rotating the operator key and restarting the backend blocks old publisher
credentials; it does not revoke notebook links.

To withdraw a notebook, run from a trusted machine:

```sh
python3 scripts/withdraw_notebook.py https://notes.example.org/notebook/NOTEBOOK_ID --key-file /private/path/publisher.key
```

This authenticated operation deletes that server notebook and its PDFs, closes
current readers/writers, and permanently tombstones the notebook identity. A still
running desktop cannot republish that identity. Local notes remain intact; restore
a portable backup as a new notebook if a new read identity is needed. Downloaded
copies cannot be recalled. Restoring an older server backup can also restore old
links/tombstones; assess it before making that backup public again.

The server never accepts the publisher key through query parameters. Do not enable
unredacted access/debug logging: notebook paths, Referer and authentication headers
can contain capabilities. The provided proxy filters private request fields and
Uvicorn access logging is disabled. The supported `python -m app.server` entry
point additionally redacts 64-digit hex capabilities/keys and truncates client IP
addresses (IPv4 /24, IPv6 /48) in diagnostic messages and exception tracebacks.
It logs at `warning` by default, so connection messages are not written unless
`LIVEMITSCHRIFT_LOG_LEVEL=info` is set for diagnosis.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: on the repository's
**Security** tab, choose **Report a vulnerability**. Do not open a public issue,
and never post publisher keys or private notebook links. You will receive an
answer as soon as possible; this is a small volunteer project without a formal
response-time commitment.

CI checks and local scans are useful, but they are not an independent security
audit or a guarantee that the service has no vulnerabilities.
