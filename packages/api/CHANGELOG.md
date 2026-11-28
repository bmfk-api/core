# Changelog

## 1.2.0 — 2026-11-28

### Server

- **Data folder: `~/.bmfk/<project>` by default** (was `/var/bmfk/<project>`), so nothing needs sudo and
  each user's projects stay in that user's home (folders 0700). `/var/bmfk` is still used while it
  holds a project folder this user can write to — said once at start — and `BMFK_DATA_DIR` still wins.
  `bmfk data move [--yes]` moves the folders to `~/.bmfk` and leaves a link in place of each, so paths
  already written into deployed code keep working; deploy each project once afterwards. A user without
  a home folder keeps `/var/bmfk`.
- `logLine(item)`: a log item as a stdout line. Under systemd (when stdout goes to the journal) it
  starts with the level for journald, so `journalctl -p warning` and `bmfk ps log --errors` find
  warnings and errors. The deployer made by `deployer-init` uses it.
- Monitor: restart works for an app the deployer runs as a systemd unit, too (it was pm2 only); the
  confirmation is the process name. The restart now goes through the graceful stop. A new log source
  `journal` reads the unit's systemd journal.
- Graceful stop. On SIGTERM or SIGINT (a deploy, `systemctl stop`, `pm2 restart`) the server stops taking
  connections, closes idle ones, and lets requests in progress finish for up to `shutdownTimeoutMs`
  (default 10 s); then the rest are cut and the services' `finishService` run, so a database pool is
  never closed under a running request. A request on a kept-alive connection during the stop gets 503
  with `Connection: close`. A second signal exits at once. Under pm2 give it time to finish:
  `--kill-timeout 12000` in the pm2 flags (pm2's own default is 1.6 s).
- `APIService.addReadinessCheck(name, check)`: what must work for the app to serve (a database, a
  queue). `GET /readiness` answers 503 while a check fails or the app is stopping, without saying why
  (it is public); the reasons go to the log, once per change, and to `bmfk ps show`. With no checks
  nothing changes.
- Control channel. When the deployer starts an app (systemd or pm2) it passes a unix socket path in
  `BMFK_CONTROL_SOCKET` (`<data folder>/<project>/control[-<slot>].sock`); the app listens on it, mode
  0600, so only the same user can connect, and no port is opened. A fixed set of operations: `ping`,
  `metrics` (requests and 5xx per minute, requests in progress, connections, event loop delay and load,
  heap), `ready` (the readiness checks with reasons), `refresh-live`, `loglevel`. A change of log level
  is logged by the app. An app started any other way has no socket.

### Deployer

- `"runner": "systemd"` in a project config runs the app as a systemd user unit,
  `bmfk-<project>[-<slot>].service` in `~/.config/systemd/user`, instead of pm2. The unit is written
  on every deploy and restore, enabled (it starts at boot once `loginctl enable-linger` is set for the
  deployer's user) and restarted; a process that is not still running 3 seconds later fails the
  deploy. The unit restarts the app whenever it exits, stops it with SIGTERM, and by default keeps it
  in a sandbox: read-only system and home, private `/tmp`, writable deploy and data folders only.
  Settings go in a `"systemd"` block (`node_args`, `env`, `memory_max`, `stop_timeout`, `sandbox`); values
  that would need escaping in a unit file are refused before anything is written.
- `bmfk ps`: the processes under systemd, pm2-style, straight from systemd (works while the deployer
  is down). `bmfk ps list` shows id, project, slot, state, pid, uptime, restarts, memory, cpu, port and
  whether it starts at boot, then pm2's processes if pm2 is there. `bmfk ps log <id|name|all>` with
  `-f`, `-n`, `--errors`, `--since`; `show`, `start`, `stop` (also keeps it from starting at boot),
  `restart`. `bmfk ps startup` checks what a start at boot needs (linger, a journal kept on disk, the
  user's systemd) and prints the commands to fix it; it never runs sudo. Ids are kept in the units and
  don't change between deploys; a project name means both its slots. `bmfk ps watch [-i 2]` redraws the
  list until Ctrl+C. `bmfk ps show` adds peak memory, threads and disk read/write (the unit turns on
  `IOAccounting`; shown where the io controller is delegated to the user).
- `bmfk ps list` and `watch` add what the apps say over the control channel: requests and 5xx per
  minute, event loop delay (p99) and heap, in yellow when there are 5xx, the loop stalls (≥ 200 ms) or
  the heap is over 80 % of its limit; pm2 processes started by the deployer too. `bmfk ps show` adds the
  version, live or standby, log level, requests in progress, connections and each readiness check with
  its reason. `bmfk ps loglevel <id|name|all> [level]` shows or changes the log level until the next
  restart.
- A switch of blue-green slots tells both slots over their control sockets at once; each asks the
  deployer for its state, so `APIService.onLiveChange` (crons, queue consumers) follows within a
  second instead of at the next poll. Slots without the channel catch up as before.
- `systemd.memory_high`: above it the app is slowed down and pushed to free memory (`MemoryHigh`), before
  `memory_max` kills it; it must be below `memory_max`.
- Watchdog: processes under systemd are checked every 10 seconds. A crash that systemd restarted, a
  crash loop (systemd gave up) and a recovery go to Telegram and the project's emails. Restarts are
  reported at most once per process per 5 minutes, with the count. `bmfk ps stop` is not reported.
- `bmfk deployer-init` on Linux runs the deployer as a systemd user unit by default (pm2 on request, or
  where systemd's user manager isn't reachable): it writes `bmfk-<name>.service`, starts and enables it,
  and runs `bmfk ps startup`. The deployer's own unit has no sandbox and no `NoNewPrivileges`, since it
  writes the projects' folders and nginx files and its switch hook may use sudo. pm2 is no longer
  needed with systemd.
- `bmfk ps startup` also checks user namespaces, which the units' sandbox needs, and warns when
  AppArmor restricts them.
- pm2 stays: without `"runner"`, `"pm2": true` still means pm2 and `"pm2": false` starts nothing.
  `"runner": "none"` is the same as `"pm2": false`.

## 1.1.1 — 2026-11-27

Fixes from a security review of 1.1.0.

### Breaking

- Monitor: a user without a role (or with an unknown one) gets no access. It used to get `admin`. Set
  `role` (`admin`, `it`, `analytic`) on every monitor user; the service names the users without one at
  startup, and `npx bmfk access-config` shows them as "no role — no access".

### Security

- SQL kept for diagnostics — the longest queries in the monitor's database panel, transaction failure
  reports, `debug` query logs — is masked: values of columns with a sensitive name (password, token,
  cvv, pan, card_number, exp, …) in `col = value` and `(cols) VALUES (…)`, and card numbers anywhere
  (Luhn). `LogService.sanitizeSql()` does it.
- Failed sign-ins (monitor, documentation, deploy review): the counters are bounded (10 000 logins) and
  forget failures older than the lockout time, so sign-ins with random logins can't grow memory. A
  locked login stays locked.
- `host` option: the address to listen on (`"127.0.0.1"` behind nginx on the same machine). Without it
  the service listens on every interface, as before, and says so at startup. `bmfk deployer-init` writes
  `host: "127.0.0.1"` for the deployer.
- Deploy review: a journal entry that can't be written goes to the log in full, instead of being dropped.

- `InterceptorPayAuth`: the result (`req.interceptorResult`, which the request log records) no longer
  contains the shared key — everything of the key entry but `key`. The log masks fields named `key`,
  `secretKey`, `hmacKey`, `sharedKey`, `signingKey` too. If PayAuth ran with real keys and the request log
  was on, replace those keys: they could be read in the monitor's log by the `it` and `admin` roles.
- `InterceptorSignedAuth`: two copies of one request checked at the same time could both pass (the nonce
  was recorded after the asynchronous checks). A nonce is now held while its check runs, and used nonces
  are shared by every instance in the process.
- `InterceptorSignedAuth`: a form field with several files is refused — only one file's hash per field was
  signed, while the handler got them all. File names and MIME types are not signed: don't trust them.
- Deploy review: an upload in the moment between the approval and the start of the deploy could replace
  the approved archive, and the new one was deployed. The project now stays busy from the approval on,
  and only the archive with the approved hash is deployed.
- Deploy review: an unreadable or damaged reviewers' 2FA file refuses sign-in (and says so in the log)
  instead of offering a new enrollment that would overwrite it.
- API documentation page: served by the API, it signs in only to its own origin; `?host=` (which could send
  the password and code to another server) is ignored there. The page is sent with a Content-Security-Policy
  (`connect-src 'self'`).
- `REQ_DB` with `throwable`: the database's message (tables, constraints, values) no longer goes into the
  error's `details`, which the client gets; it is logged and kept in the stack (dropped in production).
- Deploy: `host`, `switch_host` in `deploy.json` and `review_url` in `setup.json` must be https; http only to
  localhost (an SSH tunnel).
- Deploy with `secrets`: a config value that would be written into the code (an ES module project, a
  placeholder outside a quoted string in a CommonJS `.js`/`.cjs`) stops the deploy instead of a warning —
  it would also land in every backup.

### Deployer

- `bmfk project-config`: the description defaults to the project name. Left empty, the config failed the
  deployer's own validation.
- The project name rule lives in `ConfigRules`, with the other rules the config generator on the website
  shares with the CLI (password length, logins, scrypt hash format, the project config it builds).

## 1.1.0 — 2026-11-24

Security fixes reported by @sorokin-vladimir in #2–#5, reworked so existing PayAuth clients keep working.

### Security

- `InterceptorPayAuth` **v2** (`PayAuth v=2`): the signed message is `bmfk-payauth-v2`, method, path, key id,
  `ts` (epoch milliseconds only), nonce and `b64`, one per line, so a request is bound to its endpoint and key.
  `InterceptorPayAuth.sign()` builds the header and `b64` for a client.
- `InterceptorPayAuth` **v1** stays as it was for clients (`b64 + ts + nonce`, `ts` in seconds or
  milliseconds), with the replay fixed on the server: digits moved from the end of `ts` to the start of the
  nonce gave a new nonce with the same signature. Signatures are now remembered with nonces, for the whole
  window, across every endpoint. A key that signs with v1 is logged once; `{ kid, key, v1: false }` turns
  v1 off for that key.
- `InterceptorPayAuth`: a key that isn't hex, or is shorter than 16 bytes, fails at startup (a per-call
  key refuses the request). A non-hex key used to be decoded to a few bytes or to an empty key, and with an
  empty key anyone could sign.
- `REQ_DB` fields: options (raw SQL with `system: true`, `ignoreInUpdate`, …) come only from the new
  `dbField(value, options)`. A plain `{ value, system: true }` from request data was put into the SQL as is.
  **Breaking:** a plain object with `value` and only option keys now fails with an error naming the field;
  any other object or array is stored as escaped JSON. `bmfk migrate` rewrites such literals to `dbField()`.
- `REQ_DB` nested `fields` (`@name` inside a value) fill only a raw fragment (`system: true`): inside an
  escaped value they could close its quotes. `0`, `""`, `false` and `null` are filled in too; they were
  skipped and left `@name` in the SQL.
- Validation: only the model's own keys are fields. `constructor`, `toString` and other `Object.prototype`
  names passed into the request data unchecked.

### Deployer

- `bmfk project-config` and `bmfk setup-config` find the deployer made by `bmfk deployer-init` (its
  `bin/Main.js` in the current folder, else `/var/bmfk/bmfk-deployer`). The project config is saved into
  the deployer's projects folder by default, not the current folder, and `setup-config` opens its
  `setup.json`.
- `bmfk project-config`: when a project requires review, the wizard checks the deployer's `setup.json`.
  It names reviewers that are not there, asks for `review_url` if it is missing (the review page,
  `<deployer address><baseEndPoint>review/html`) and warns when no notifier is set. Uploads are refused
  until all three are in place.
- `bmfk project-config`: the `deploy.json` it writes has no password placeholder; the wizard points to
  `bmfk deploy-key`, which adds the signing key.

## 1.0.1 — 2026-11-24

### Release process

- Published from CI through an npm Trusted Publisher (OIDC): no npm token exists anywhere. The release
  workflow checks that npm supports it (11.5.1+) and waits for approval on the `npm` environment.

## 1.0.0 — 2026-11-23

First release of `@bmfk/api`: a TypeScript framework for HTTP API services on Node.js, built so that a
service written with it holds up in a PCI DSS assessment without extra plumbing. One `npm install` brings
the HTTP server, the database adapters, an operations console, API documentation and a deployer.

### Requirements

- Node.js 24 or later (the supported LTS lines; tested on 24 and 26).
- One entry point: everything is imported from `@bmfk/api`. Paths inside the package (`@bmfk/api/dist/…`)
  are closed by `exports`.
- On servers, a data folder `/var/bmfk/<project>/` owned by the service user (override: `BMFK_DATA_DIR`).
  Without it the service falls back to a folder beside the code and says so at startup.

### What is in it

- **Endpoints.** Express 5 under the hood, endpoints declared as classes, request and response types
  `IRequest` / `IResponse`, file uploads, raw responses, interceptors for authentication, and a trace id
  on every response (`X-Request-Id` and `traceId`).
- **Validation models.** A model is a sample object with typed fields, `min` / `max`, allowed values,
  optional fields and nested objects. A number sample is only the type; bounds are always explicit.
- **Databases.** `MysqlAdapter` and `PostgresAdapter`, both drivers included; queries go through `REQ_DB`.
- **Signed microservice calls.** Each service has an Ed25519 key pair (`bmfk ms-key`). The caller signs
  every request, and the host signs every answer, bound to that request. Hosts list their callers and what
  each may call, optionally limited by address. An operation id runs an operation once across retries.
  Signed calls go over https only (plain http only to localhost).
- **Signals.** `Signal` and `Req` for messages and requests inside a service. A subscriber that throws does
  not stop the others.
- **Outgoing HTTP client.** `Http` with timeouts and latency metrics per host. Requests are not retried
  unless a call asks for it, so a payment is never sent twice by accident. `skipLogging` records a call
  with its origin only, for requests whose URL or body must not reach the journal.
- **Logging and redaction.** Card numbers, CVVs, passwords, tokens and keys are redacted before anything is
  written or shortened, in the log, the request journal and the outgoing request journal. Logged objects
  are never modified.
- **Operations console** (`sm/html`). Metrics that survive restarts and deploys, logs, request journals
  searchable by trace id, threats, blocked IPs, and restart. Sign-in with a password hash and mandatory
  TOTP, roles, short sessions and lockout. Users live in `access.json`, re-read on change.
- **API documentation** (`doc/html`) for partners, generated from the endpoints and their models. Same
  sign-in as the console: password hash, TOTP enrolled at the first sign-in, 15-minute idle and 8-hour
  sessions, lockout.
- **WebSocket server** on the same port, with origin checks, authorization within a time limit, and limits
  on message size, rate and connections.
- **IP blocking** and threat monitoring that records probing clients.
- **Deployer.** Deploys signed with Ed25519 (the server keeps only public keys), blue-green releases with
  liveness checks and rollback, backups and restore, optional deploy review by a second person, secrets
  injected on the server so they never live in the repository, `npm ci --omit=dev`, Telegram
  notifications and an audit trail. `bmfk deployer-init` sets up a deployer on a server in one
  interactive run.
- **CLI** `bmfk`: deploy, activate, status, backups, restore, key and token generation, password hashing,
  config wizards (`bmfk wizards`), `deployer-init`, and `migrate` for projects on the legacy server.

### Secure by default

- CORS allows only the API's own origin until you list others. `"*"` means any origin, never with
  credentials.
- Production mode unless `NODE_ENV=development`.
- A failure returns only a code and a generic message to the client; the cause and the stack stay in the
  log under the same trace id.
- Passwords and tokens in configs must be hashes (salted scrypt); plain text is refused. Comparisons run in
  constant time.
- The deployer accepts signed requests only.
- A WebSocket server does not start without `onAuthorize`, unless it is declared `public: true`.
- Proxy headers are trusted only from `trustedProxies` (loopback by default).
- Uploads go to `/var/bmfk/<project>/uploads` with mode 0700, not to `/tmp`.
- The console and the documentation are closed until `access.json` exists; by default it is read from
  `/var/bmfk/<project>/access.json`.

### Supply chain

- Published only from CI, from a release tag, with npm provenance. Each GitHub release carries a CycloneDX
  SBOM.
- `npm audit`: 0 vulnerabilities. `esbuild` and `@babel/parser` are optional peer dependencies, loaded only
  by `bundle`.

### Coming from the legacy server (6.x)

1.0 is a new product, not an upgrade: it does not talk to 6.x services or deployers, and it does not read
their files. `npx bmfk migrate` rewrites a project's imports, scripts and validation models and lists what
is left to do by hand. Read the
[migration guide](https://github.com/bmfk-api/core/blob/main/docs/migration-from-legacy.md) before
moving a service.
