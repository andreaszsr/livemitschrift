# Server installation and operations

Use Docker Engine with Compose v2.24.4+ on a Linux VPS. One backend process/replica
is supported. Until a release image is published on GHCR, build the image from
this repository (see [Build the image yourself](#build-the-image-yourself)).

## First installation

Point the chosen DNS name at the VPS. Allow inbound TCP 80/443 and your restricted
SSH access. Do not expose port 8000. Docker publishes ports using its own rules;
verify the public ports from outside the VPS. Install supported Docker/Compose
from the [official installation instructions](https://docs.docker.com/engine/install/).

Copy the release source or deployment files to the server, then:

```sh
python3 scripts/prepare_deployment.py /opt/livemitschrift
cd /opt/livemitschrift
```

Use an account allowed to write the destination. The preparation command refuses
to overwrite existing deployment files or a publisher key. Edit `.env`:

```dotenv
DOMAIN=notes.example.org
ACME_EMAIL=operator@example.org
LIVEMITSCHRIFT_IMAGE=ghcr.io/andreaszsr/livemitschrift:0.2.0
```

Use the actual published version or its immutable `@sha256:...` digest, or a
locally built image (below). Configure
the GHCR package as public if installation should work without a registry login.
The Compose project name is `livemitschrift`; keep it stable so updates reuse the
same volumes. If subnet `172.30.81.0/24` conflicts with an existing network, change
both fixed container IPs and `LIVEMITSCHRIFT_TRUSTED_PROXIES` consistently.

```sh
docker compose pull          # skip for a locally built image
docker compose up -d --wait
docker compose ps
curl --fail https://notes.example.org/health
```

Caddy obtains and renews certificates; persist its two volumes. The Compose file
pins the Caddy image version; review and raise it deliberately. Caddy compresses
responses (zstd/gzip); static viewer modules are revalidated via ETag
(`Cache-Control: no-cache`), while documents and API data remain `no-store`. The backend has no
host port and only accepts forwarded headers from Caddy's explicit private IP.
Do not change the trusted-proxy setting to `*` or add backend workers/replicas.
Caddy needs only `NET_BIND_SERVICE`; the backend drops all capabilities and runs
as UID/GID 10001 with a read-only filesystem. Notes are stored in the `notes` volume.

The generated publisher key is in `secrets/publisher.key`. Keep the `secrets`
directory mode **0700** and `.env` mode **0600**. The key file itself is **0444**:
Compose bind-mounts the individual file, which must be readable by container UID
10001; the private host directory prevents other host users traversing it. Do not
copy it to a world-readable directory. Compose's file-backed secret mounts do not
apply the service `uid`/`mode` settings; see [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

In the Mac app's **Teilen** dialog enter the HTTPS origin and only the key value,
then enable synchronization. Use a built app (`npm run desktop:build`): a public
server accepts only the native app origin, so `npm run desktop:dev`
(`http://127.0.0.1:1420`) is rejected with 403 and the app keeps showing
"Verbindung unterbrochen". The key may be remembered in the macOS Keychain.
Distribute the generated notebook read URL, never the publisher key. HTTP browser
requests redirect to HTTPS; publishing through a remote plaintext URL is refused.

### Build the image yourself

On the server (or any machine with the same CPU architecture), from a checkout of
the release you want to run:

```sh
docker build -t livemitschrift:0.2.0 .
```

Set `LIVEMITSCHRIFT_IMAGE=livemitschrift:0.2.0` in `.env` and skip
`docker compose pull`. For updates, check out the new version, build with a new
tag and change `.env` accordingly.

## Lecturer accounts

The key in `secrets/publisher.key` belongs to the built-in administrator account
`admin`. Give every other lecturer an own account and personal key:

```sh
cd /opt/livemitschrift
sudo docker compose exec backend python -m app.users add mustermann --name "Erika Mustermann"
sudo docker compose exec backend python -m app.users key-create mustermann --label "MacBook"
```

The key is printed once; hand it over privately. Further commands: `list`,
`keys <user>`, `key-revoke <user> <id>`, `disable`/`enable <user>`, `notebooks`
and `transfer <notebook-id-prefix> <user>`. A notebook belongs to whoever
publishes it first (existing notebooks are claimed by their next publisher);
others cannot publish into it. Each account may own
`LIVEMITSCHRIFT_MAX_NOTEBOOKS_PER_USER` notebooks (default 20).
The database schema is upgraded in place (version 2) on first start; take a
backup before updating.

## Host hardening (checked on Ubuntu 26.04)

- Provider firewall in front of the VPS (e.g. Hetzner Cloud Firewall): inbound
  TCP 22, 80, 443 and ICMP only. Docker publishes ports past host `ufw` rules,
  so the provider firewall is the reliable outer boundary; keep `ufw` as well.
- SSH: an admin user with your key and sudo; a first-sorting drop-in such as
  `/etc/ssh/sshd_config.d/00-hardening.conf` with `PermitRootLogin no`,
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `X11Forwarding no`, `MaxAuthTries 3`, `AllowUsers <admin>`. Run `sshd -t` and
  test a second login before closing the current session.
- `fail2ban` with its default `sshd` jail.
- `unattended-upgrades` enabled, with `Unattended-Upgrade::Automatic-Reboot "true"`
  at a night-time `Automatic-Reboot-Time`; the stack restarts by itself.
- After restoring a snapshot, run a full upgrade and reboot, and check `DOMAIN`
  if the server received a new IP address.

## Start and stop on demand (Hetzner Cloud example)

`deploy/hetzner/` is an optional example for Hetzner Cloud; adapt it for other
providers. To pay only for lecture hours, keep the primary IPs and a snapshot and run the
server only when needed. One-time setup: `brew install hcloud`, create a project
API token (read & write), `hcloud context create <name>`, and label the kept
primary IPv4/IPv6, firewall and snapshot with `app=livemitschrift`
(`hcloud … add-label <id> app=livemitschrift`). Optional local settings, e.g.
`LIVEMITSCHRIFT_SSH_USER=<admin>`, go to `~/.config/livemitschrift/hetzner.env`.

```sh
sh deploy/hetzner/up.sh     # newest snapshot → server with kept IP/firewall, wait for HTTPS, install updates
sh deploy/hetzner/down.sh   # stop app, shut down, snapshot, delete server, prune older snapshots
```

The down script deletes the server only after the new snapshot is available and
refuses to run if a primary IP would be deleted with the server. The API token
can create and delete paid resources; protect `~/.config/hcloud/cli.toml`.
Reader links are unavailable while the server is off.

## Local image test before publication

From the repository, with Docker running:

```sh
docker build -t livemitschrift:test .
.venv/bin/python scripts/create_pdf_test_slide.py
.venv/bin/python scripts/test_container.py --image livemitschrift:test --viewers 50 --duration 10
```

The runner creates a disposable Compose project and named volumes, uses actual
HTTPS/WSS with its own local CA, trusts that CA only in its clients, and removes
its containers/volumes on completion. It never opens or changes the normal app's
data or publisher configuration. Run it on the Docker host; a remote Docker daemon
cannot read the local bind-mount paths.

## Backup

The SQLite backup API produces a consistent snapshot while the server runs.
Store backups privately and copy them off the VPS. The data volume needs free
space for the temporary full snapshot as well as normal database growth.

```sh
cd /opt/livemitschrift
install -d -m 700 backups
umask 077
docker compose exec -T backend python -m app.maintenance backup > backups/notes.new
mv backups/notes.new backups/notes-2026-11-01.sqlite3
```

Only run `mv` after the backup command succeeds. A backup includes confirmed
notebooks, PDF resources, acknowledgements and withdrawn identities. Separately
back up `.env`, `Caddyfile`, `compose.yaml`, and `secrets/publisher.key` with equally
restricted access. Do not commit these files. Desktop portable notebook backups
are independent and remain useful when the server is lost.

## Restore

Take a current backup first, pause app synchronization, and use the image version
matching the snapshot. This replaces the server's entire data set:

```sh
cd /opt/livemitschrift
docker compose stop backend
docker compose run --rm --no-deps -T backend python -m app.maintenance restore --replace < backups/notes-2026-11-01.sqlite3
docker compose up -d --wait
```

Restore checks the exclusive server lock, SQLite integrity, required tables,
schema version and configured size limit before atomic replacement. A running
backend prevents restore. A crash journal must be recovered before replacement.
Readers reconnect after restart. The desktop stays authoritative; a server restored
to an older acknowledged revision may require a page-by-page recovery. Never
replace a running SQLite file by copying it directly.

## Update and rollback

Back up first. Change `LIVEMITSCHRIFT_IMAGE` to the reviewed version/digest, then:

```sh
docker compose pull
docker compose up -d --wait
```

Never use `docker compose down --volumes` on a real installation: it deletes notes
and certificates. For rollback use the previous image and, if schemas changed, its
matching snapshot. Keep the publisher key stable across updates. To rotate it,
stop the backend, replace the secret file with a new random 64-hex-character value
and restore its permissions, then recreate the backend and update the Mac key.
Restart closes existing publisher sessions; notebook reader links are unchanged.

## Limits and monitoring

Defaults: 96 readers, 128 total WebSockets, 32 active HTTP handlers, two PDF
extractions, two concurrent page exports (10 s queue, then HTTP 503 with
`Retry-After`), 128 notebooks and a 4 GiB SQLite limit. PDFs may be up to 50 MB;
each notebook holds at most 128 PDFs and 500 MB of PDF data, plus up to 500 MB of
cached single-page extracts. Per-client queues and request rates are bounded;
slow readers and readers over their request budget reconnect (close code 1013).
Students behind one campus NAT share the per-IP limits; run the 50-reader test
from a single public IP. The shared encoded-page cache targets
16 MB, retaining at most one oversized page (page limit 64 MB). Limits are
application bounds, not a guarantee against denial of service.

Override `LIVEMITSCHRIFT_MAX_CONNECTIONS`, `LIVEMITSCHRIFT_MAX_READERS`,
`LIVEMITSCHRIFT_MAX_HTTP`, `LIVEMITSCHRIFT_MAX_DATABASE_BYTES` or
`LIVEMITSCHRIFT_MAX_NOTEBOOKS` in a Compose override when necessary. Keep enough
memory for decoded ink, transient transfers, PDF extraction and SQLite. Monitor
`docker stats`, free disk space, backup success and health. The default container
memory caps are 1 GB backend (large PDFs are parsed in memory) and 128 MB proxy. A 2 GB VPS also needs OS/Docker
headroom. A local test is not a sizing guarantee for a rented single-core VPS.

Access logging is disabled by default; Caddy's diagnostic log filters private
headers and request URIs and masks client IPs (IPv4 /24, IPv6 /48). The backend
logs at `warning` by default, so per-connection lines with client addresses are
not written at all; set `LOG_LEVEL=info` in `.env` only temporarily to diagnose
(addresses are still truncated). Docker rotates logs by size (3 × 10 MB).

Privacy notice: copy `config/datenschutz.example.html` to `config/datenschutz.html`
(mode 0644), replace the placeholders and run `docker compose up -d`. The server
serves it at `/datenschutz` and links it from the start page and the viewer menu
(**Datenschutz**); edits take effect without a restart. Alternatively set
`PRIVACY_URL` in `.env` to an external HTTPS page, which takes precedence. A
longer German template is in [privacy-notice-template.md](privacy-notice-template.md).

Source link: AGPL-3.0 section 13 requires offering the source of the running
version to its users. The start page and the viewer menu link **Quellcode**.
Release images point to their upstream tag automatically. If you run a modified
version, set `SOURCE_URL` in `.env` to an HTTPS page with your source code.

The supported backend entry point also redacts 64-digit
hex capabilities/keys from Uvicorn diagnostics, including WebSocket URL messages
and exception tracebacks. Do not enable unredacted proxy/debug logging on a public
service: notebook URLs are read capabilities. See [SECURITY.md](../SECURITY.md).
