# Changelog

## 1.0.2 — 2026-11-24

### Security

- `InterceptorPayAuth`: a captured request could be replayed with a new nonce, or sent to another
  endpoint. The signature covered `b64 + ts + nonce` glued together, and `ts` could have 10 or 13
  digits, so the last three digits of a millisecond `ts` could move into the nonce without changing
  the signature. **Breaking:** the signed message is now
  `bmfk-payauth-v1 · METHOD · path · kid · ts · nonce · b64`, one per line, and `ts` must be epoch
  milliseconds (13 digits). `InterceptorPayAuth.sign()` builds the header for a client.

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
