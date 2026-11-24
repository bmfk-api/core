# @bmfk/api

A batteries-included TypeScript framework for HTTP API services on Node.js: endpoints with validation, an
operations console (metrics, logs, restart) behind 2FA, a deployer with zero-downtime blue-green releases and
backups, an outgoing HTTP client with latency metrics, log redaction for payment data, and a WebSocket server
on the same port.

```bash
npm install @bmfk/api
```

Node.js 24+ is required (the supported LTS lines). Everything is imported from `@bmfk/api` itself; the
package has no other entry points.

---

## Contents

1. [Quick start](#quick-start)
2. [Endpoints](#endpoints)
3. [Validation models](#validation-models)
4. [Interceptors (authentication)](#interceptors-authentication)
5. [API documentation](#api-documentation)
6. [Outgoing HTTP client](#outgoing-http-client)
7. [Microservice calls](#microservice-calls)
8. [Logging and redaction](#logging-and-redaction)
9. [Signals and requests between services](#signals-and-requests-between-services)
10. [Monitor console (`sm/*`)](#monitor-console-sm)
11. [IP blocking](#ip-blocking)
12. [Authentication](#authentication)
13. [WebSocket server](#websocket-server)
14. [Deployer and CLI](#deployer-and-cli)
15. [Blue-green deployments](#blue-green-deployments)
16. [Backups and restore](#backups-and-restore)
17. [Deploy review](#deploy-review)
18. [Options reference](#options-reference)
19. [Security](#security)

---

## Quick start

```ts
import { APIService, Initializer, getDefaultOptions } from "@bmfk/api";
import { Users } from "./endpoints/Users";

const api = new APIService(getDefaultOptions({
  port: 8080,
  baseEndPoint: "/api/v1/",
  projectName: "my-service",
  isProductionEnvironment: true,
  corsHostWhiteList: ["https://app.example.com"],
  endpoints: [new Users()],
}));

Initializer([api]);
```

Every response has the same envelope:

```jsonc
// success
{ "data": { … }, "responseTime": 4, "endpoint": "/api/v1/users/get", "version": "1.2.0", "traceId": "…" }
// error
{ "error": { "code": 401, "message": "Unauthorized", "httpStatus": 401, "details": "…" } }
```

Built-in routes: `liveness` and `readiness` (for load balancers and orchestrators), `doc/*` (API documentation),
`sm/*` (monitor console) and, if configured, `pckg/*` (deployer).

---

## Endpoints

An endpoint class groups handlers under one path segment:

```ts
import { BaseEndpoint, IRequest, IResponse } from "@bmfk/api";

export class Users extends BaseEndpoint {
  constructor() {
    super("users");                       // → /api/v1/users/…
    this.registerEndpoints([
      {
        endpoint: "get",                  // → /api/v1/users/get
        handler: this.get,
        title: "Get a user",
        description: "Returns one user by id",
        validationModel: { id: 0 },
      },
      {
        endpoint: "profile",
        handler: {                        // different handlers per HTTP method
          GET:  this.profile,
          POST: { controller: this.updateProfile, validationModel: { name: "" } },
        },
      },
    ]);
  }

  async get(req: IRequest): Promise<IResponse> {
    return { data: { id: req.data.id } };
  }
}
```

`req.data` merges the JSON body, form body and query string. Other useful fields: `req.headers`,
`req.params`, `req.files` (uploads), `req.ip` (the real client address, see
[`trustedProxies`](#options-reference)) and `req.interceptorResult` (whatever your interceptor returned).

Per-endpoint flags:

| Flag | Effect |
|---|---|
| `ignoreInterceptor` | skip authentication for this endpoint |
| `allowInterceptorError` | run the handler even if the interceptor rejected the request |
| `validationModel` | validate the request |
| `resultModel` | describe the response in the API documentation (not checked at runtime) |
| `asStream` | stream the response |
| `ignoreInDocumentation` | hide from `doc/*` |
| `ignoreHttpLogging` | keep out of the request log (polling endpoints, secrets) |
| `independed` | register the path as is, without `baseEndPoint` |

A handler can return an error with `throw { ...DefaultErrors.NOT_FOUND, details: "…" }` or
`return { error: { code, message, httpStatus } }`.

---

## Validation models

A validation model is a sample object. The type of each value is the type of the field:

```ts
validationModel: {
  email: "",                          // string, required
  age: 0,                             // number
  agree: false,                       // boolean
  tags: [""],                         // array of strings
  address: { city: "", zip: "" },     // nested object

  status: "",
  $__status_values: ["new", "paid", "refunded"],   // allowed values (shown in documentation too)

  comment: "",
  $__comment_optional: true,

  amount: 0,
  $__amount: { min: 1, max: 100000, details: "Amount in cents" },

  phone: "",
  $__phone: { regex: "^\\+[0-9]{8,15}$" },
}
```

A sample value is only the type: `amount: 100` means "a number", not "at most 100". Limits are always
written as `min` / `max`.

For a field `X`, options live in `$__X` (an object, or a string used as the description) or in
`$__X_optional`, `$__X_values`, `$__X_ignore_in_documentation` and similar keys. Supported options:
`optional`, `default`, `values`, `min`, `max`, `regex`, `type` (`email`, `phone`, `date`…) and `details`.

The `ValidationModel<typeof model>` type turns a model into a TypeScript type, optional and enum fields
included. `Validator.validateStructure(model, object)` can be used on its own, outside endpoints.

---

## Interceptors (authentication)

An interceptor runs before every endpoint that doesn't set `ignoreInterceptor`. It returns the caller's
identity, or an error:

```ts
import { IInterceptor, DefaultErrors } from "@bmfk/api";

class SessionInterceptor implements IInterceptor<{ userId: number }> {
  async intercept(req) {
    const user = await sessions.find(req.headers.authorization);
    return user ?? { ...DefaultErrors.UNAUTHORIZED };
  }
}

getDefaultOptions({ interceptor: new SessionInterceptor(), … });
// handlers then read req.interceptorResult.userId
```

Two ready-made interceptors handle signed server-to-server requests. Both use a timestamp window and
nonce replay protection:

- **`InterceptorPayAuth`** uses an HMAC-SHA256 signature with a shared key. The signature covers
  the method, path, key id, timestamp (epoch milliseconds), nonce and body;
  `InterceptorPayAuth.sign()` builds the header and the `b64` field for a client.
- **`InterceptorSignedAuth`** uses Ed25519 key pairs. The caller keeps the private key, and the
  server stores only public keys, so nothing on the server can be stolen and reused. The signature
  covers the method, path, timestamp, nonce, every field and the sha256 of every uploaded file.

```ts
import { InterceptorSignedAuth } from "@bmfk/api";

// server: public keys by key id
const interceptor = new InterceptorSignedAuth(kid => partners[kid]?.publicKey);
// handlers then read req.interceptorResult.kid

// client
const { publicKey, privateKey } = InterceptorSignedAuth.generateKeyPair();
const authorization = InterceptorSignedAuth.sign({ privateKey, kid: "partner-1", method: "POST", url, data: body });
```

---

## API documentation

`GET <baseEndPoint>doc/html` is an interactive page, and `<baseEndPoint>doc/json` is the same data as JSON.
Both are built from your endpoints: titles, descriptions, request models, allowed `values` and result models.

Access is restricted to users listed in `access.documentation`. A user can be limited to some endpoints:

```ts
access: {
  documentation: [{ login: "partner", password: "…", endpoints: ["/api/v1/orders"] }],
}
```

Hide an endpoint with `ignoreInDocumentation`. The built-in `sm/*` and `pckg/*` endpoints are always hidden.

---

## Outgoing HTTP client

```ts
import { Http } from "@bmfk/api";

const res = await Http.post("https://api.example.com/charge", { amount: 100 }, {
  headers: { authorization: `Bearer ${token}` },
  timeoutMs: 15_000,
  retry: { enabled: true },
});

if (!res.ok) {
  // res.status is undefined on network errors; res.error holds the details
} else {
  use(res.data);
}
```

`Http` never throws for HTTP or network errors: you always get `{ ok, status, data, error }`.

Requests are **not retried** unless you ask for it: a `504` or a dropped connection doesn't mean the other side
did nothing, and a retried payment is a double charge. `retry: { enabled: true }` retries once on network
errors and on `429`, `502`, `503`, `504`; tune it with `maxAttempts` and `retryOnStatuses`. Multipart uploads
are never retried. The default timeout is 5 seconds.

It uses connection pooling (undici), and every call is recorded for the monitor: an outgoing request log (redacted),
active connections per host and latency percentiles (p50, p95, p99) per host.

A URL that carries a secret (a bot token in the path, a key the provider wants in the query) is recorded
only as its origin with `skipLogging: true`: the call is still in the outgoing log, the slowest calls and
the stats — so you see that it was made, when, how long it took and its status — but as
`https://api.telegram.org`, marked `skipLogging` (“not logged” in the monitor), without path, query, bodies
or error text.

```ts
await Http.post(`https://api.telegram.org/bot${token}/sendMessage`, body, { skipLogging: true });
```

---

## Microservice calls

One service (the host) exposes `Req` handlers; others (callers) call them by name. Every service has its own
Ed25519 key pair — `npx bmfk ms-key` prints one. There is no shared secret: the caller signs each request,
the host signs each answer, and each side holds only the other's public key.

```ts
// host
new MicroserviceHost({
  id: "crm",
  requests: [REQ_FEES_ACTUAL, REQ_MERCHANT_ACTUAL],
  privateKey: secrets.CRM_MS_KEY,                    // the host's private key: signs its answers
  clients: {
    shop: { publicKey: "MCowBQYDK2VwAyEA…", allowedIps: ["127.0.0.1", "::1"] },  // everything in `requests`, from this server only
    reports: { publicKey: "MCowBQYDK2VwAyEA…", requests: ["REQ_FEES_ACTUAL"], allowedIps: ["10.8.0.0/24"] },
  },
});

// caller
new MicroserviceClient({
  id: "crm",
  host: "https://crm.example.com/api",               // https; plain http only to localhost
  kid: "shop",                                       // this caller's name in the host's `clients`
  privateKey: secrets.GATE_MS_KEY,
  hostPublicKey: "MCowBQYDK2VwAyEA…",                // every answer is checked against it
});

const fees = await REQ_MICROSERVICE_CALL.request({ id: "crm", requestName: "REQ_FEES_ACTUAL", requestData: { mid } });
```

- **Who may call what.** The host knows each caller by its key id and refuses requests outside that caller's
  `requests` list. A request can't be replayed, changed on the way, or redirected to another host.
- **From where.** `allowedIps` (IPs and subnets, IPv4/IPv6) limits where a caller's key works, so a leaked key
  is useless anywhere else. A call from another address gets `403` before its signature is even checked, and
  the host logs the key id and address. The address is the real client's: behind nginx it is `X-Real-IP`
  (`proxy_set_header X-Real-IP $remote_addr;`), believed only from `trustedProxies` (loopback by default);
  otherwise the TCP peer. List both `127.0.0.1` and `::1` for a caller on the same server — `localhost` can
  resolve to either. Without `allowedIps` any address is accepted; a malformed or empty list stops the host.
- **Operations run once.** Each call carries an operation id (`op`) that stays the same across retries: the
  host runs it once and answers repeats from its job store. Pass your own `op` (a payment or transfer id) to
  make it stable beyond this process. The default store is memory, so a restart forgets it: a handler that
  moves money must also record `op` in its own database, in the same transaction as the effect —
  `MicroserviceHost.currentCall()` gives the handler the caller and the `op`. An `op` reused for a different
  request is refused (`CONFLICT`).
- **Errors.** A handler's `IError` goes back without its `stack`; an unexpected exception is logged on the host
  and the caller gets a bare `INTERNAL_ERROR`.
- **Confidentiality is TLS.** Signatures prove who sent what; they don't hide it.

---

## Logging and redaction

```ts
import { logInfo, logWarn, logError, logCrit } from "@bmfk/api";

logInfo("Order created", { orderId, amount });
```

Every message is **redacted when it is written**. The objects you pass are never modified. What gets masked:

- **Card data.** PANs in any text are masked to the last 4 digits, checked with Luhn and known card
  prefixes. The same applies to fields such as `pan`, `cardNumber`, `primaryAccountNumber` (DPAN) and
  `track2`. CVV/CVC, PIN, expiry and cardholder-name fields are replaced with `<REDACTED>`.
- **Secrets.** Fields such as `password`, `token`, `authorization`, `cookie`, `apiKey` and `clientSecret`,
  secrets in query strings (`?token=…`), and passwords inside connection strings (`mysql://user:***@host`).

The incoming and outgoing request logs shown in the monitor go through the same redaction.
`LogService.sanitize(text)` and `LogService.sanitizeDeep(value)` are available for your own output.

> Redaction is a safety net, not a policy. Don't log card data on purpose: masking patterns can't
> recognize every format.

### Request tracing

Every request gets a trace id. It is returned in the `X-Request-Id` response header and as `traceId` in the
response body, and it follows everything the request causes:

- `req.traceId` in the handler, and `Trace.current()` anywhere in code the request runs, across `await`s;
- `traceId` on every log item written while handling it (pass it on in your `output`);
- the incoming request log and the outgoing HTTP log in the monitor;
- signed microservice calls: the host takes over the caller's id, so one operation has one id across services.

Behind nginx, `proxy_set_header X-Request-Id $request_id;` makes the service use nginx's id, so the nginx access
log and the service logs share it. The header is accepted only from `trustedProxies`; from anyone else it is
ignored, so a client can't plant an id that collides with someone else's records.

---

## Signals and requests between services

Services talk to each other through signals and requests instead of importing each other.

```ts
import { Signal, Req } from "@bmfk/api";

export const S_ORDER_PAID = new Signal<Order>("S_ORDER_PAID");          // one-to-many notification
export const REQ_RATE = new Req<string, number>(undefined, "REQ_RATE");  // one worker answers

S_ORDER_PAID.subscribe(order => notify(order));     // returns an id for unsubscribe(id)
REQ_RATE.listener = async currency => rates.get(currency);

S_ORDER_PAID.invoke(order);
const rate = await REQ_RATE.request("EUR");
```

- **Order.** Subscribers run synchronously, in the order they subscribed. An `invoke` from inside a
  subscriber runs after the current one.
- **Errors.** A subscriber that throws does not stop the others or break the signal; the error goes to
  `Signal.onError` (stderr by default).
- **Changes while running** apply from the next `invoke`: a new subscriber is not called in the current
  one, a removed one still is.
- **Requests.** `request()` returns a promise that rejects when the worker throws or no worker is set.
  The library's own requests (`REQ_DB`, `REQ_MICROSERVICE_CALL`, `REQ_HTTP_SERVER`, …) work the same way.

---

## Monitor console (`sm/*`)

A web console for operations: `<baseEndPoint>sm/html`, plus a JSON API used by the page.

**What it shows:**

- Process: memory, event-loop delay, open file descriptors and sockets with history (to catch leaks),
  and pm2 identity.
- System: CPU, RAM, disks, network and load.
- Metrics: request rate, errors and latency, by hour, day or week; 10 weeks of history kept on disk
  (see [Data folder](#data-folder)).
- Outgoing HTTP: per-host p50/p95/p99 and active connections.
- Logs: the application log, incoming and outgoing request logs, and tails of pm2 and nginx log files.
- Threats: clients that look like they are probing (scanners, `/wp-login.php`, `../`, bursts of 404s).
  This is observation only; nothing is ever blocked.
- Actions: change the log level, or restart the process via pm2 (the password and 2FA code are asked
  again).

**Access** is configured in `access.monitor`:

```ts
access: {
  monitor: [
    { login: "ops",     password: "scrypt$16384$8$1$…", role: "admin" },
    { login: "support", password: "scrypt$16384$8$1$…", role: "it" },
    { login: "finance", password: "scrypt$16384$8$1$…", role: "analytic" },
  ],
},
monitorAuthDir: "/var/lib/my-service",   // where 2FA enrollments are kept
```

- **Passwords must be stored as hashes.** Generate one with `npx bmfk hash-password`. The command
  asks for the password interactively and prints the config entry. A plain-text password in the config
  is refused.
- **2FA (TOTP) is mandatory.** At first login the console shows a QR code to scan with any
  authenticator app. Re-enrolling through the API is deliberately impossible: to reset 2FA, remove
  the user's record from the 2FA file on the server.
- **Roles:**

  | Role | Can do |
  |---|---|
  | `admin` | everything |
  | `it` | dashboard and logs |
  | `analytic` | dashboard only |

- **Sessions** expire after 15 minutes idle and 8 hours at most. 10 failed logins lock the account
  for 30 minutes.
- **Change access without a restart.** By default (`access: ""`) the service reads
  `/var/bmfk/<project>/access.json`; while the file doesn't exist, the monitor and the documentation are
  closed. `access` can also be another path (`access: "/etc/my-service/access.json"`) or an inline object
  of the same shape. `npx bmfk access-config` creates and edits the file from a menu. Run in the project
  folder, it finds the path the code assigns to `access` (a string literal in `src/` or the compiled
  `bin/`/`dist/`), proposes the data-folder file otherwise, or takes the path as an argument. Passwords are typed hidden and stored as hashes, and the result is
  checked with the service's own validator. The file is watched, and changes apply
  within a second, without a restart or a redeploy:

  ```jsonc
  { "monitor": [ { "login": "ops", "password": "scrypt$…", "role": "admin" } ],
    "documentation": [ { "login": "partner", "password": "…" } ] }
  ```

  - **Revocation.** Removing a user or changing their password ends their open sessions immediately.
    A role change applies to the next request.
  - **Bad edits are ignored.** If the file is invalid (broken JSON, unknown role, duplicate login), the
    change is ignored and the previous access stays in force. The reason is logged.
  - **Location and permissions.** Keep the file outside the deploy folders and `chmod 600` it. A warning
    is logged if other users can read it.
- **Restrict by address.** `monitorAllowedIps` in `access` (inline or in `access.json`) limits every
  `sm/*` request to the given IPs and CIDR subnets, the page and sign-in included. A session token
  taken elsewhere is therefore useless outside those addresses too:

  ```jsonc
  { "monitor": [ … ], "monitorAllowedIps": ["10.8.0.0/24", "203.0.113.7"] }
  ```

  Other addresses get `403`. Changes in `access.json` apply without a restart, and an invalid entry
  rejects the change. Behind nginx, pass `X-Real-IP` (see [`trustedProxies`](#options-reference)),
  otherwise every request appears to come from `127.0.0.1`.
- **Block addresses.** Admins can block an address or a subnet from the threats page, permanently or
  for a number of hours. See [IP blocking](#ip-blocking).
- **If you set `monitorAuthDir`, keep it outside the deploy folders.** Otherwise a deploy wipes the
  enrollments and everyone has to enroll again. By default they are in `/var/bmfk/<project>/`.

---

## IP blocking

Blocked addresses get a `403` on every request, whether HTTP, WebSocket, the monitor or the
documentation:

```json
{ "error": { "code": 403, "message": "Access from your address is blocked", "httpStatus": 403 } }
```

The check runs first, before body parsing, CORS and the interceptor, so a blocked client costs almost
nothing. The list is `/var/bmfk/<project>/blocked-ips.json` (see [Data folder](#data-folder)), outside
the code, so deploys and restores never touch it, and shared by both blue-green slots. It is re-read
on change.

The format:

```jsonc
[
  { "ip": "203.0.113.7", "reason": "credential stuffing", "until": "2026-12-01T00:00:00Z" },
  { "ip": "198.51.100.0/24", "reason": "scanner" }        // no "until" → permanent
]
```

- **How to edit.** Edit the file by hand, or block and unblock from the monitor (`sm/block`,
  `sm/unblock`; `admin` role). The monitor records who blocked and when. The threats page marks
  addresses that are already blocked.
- **Expiry.** Entries past `until` stop applying by themselves.
- **Invalid edits.** An invalid file is ignored, and the previous list stays in force.
- **Reasons stay private.** `reason` is shown only in the monitor, never to the client.
- **Safety rules.** Loopback is never blocked, so a proxy without `X-Real-IP` can't take the service
  down. An admin can't block their own address from the monitor.
- **Options.** `blockedIps: { file, message }` sets another location or the text of the error;
  `blockedIps: false` turns blocking off.

Blocking in the service suits targeted cases: a particular attacker or a scanner subnet. To stop a
flood, block at nginx or with fail2ban, where requests are dropped before they reach Node.

---

## Authentication

The library protects four things, each in its own way:

| What | Who uses it | How they sign in |
|---|---|---|
| Your API endpoints | your users and clients | your [interceptor](#interceptors-authentication) |
| Monitor (`sm/*`) | your operations team | password + mandatory TOTP 2FA, then a session token |
| Documentation (`doc/*`) | developers and partners | login and password (a static token) |
| Deployer (`pckg/*`) | CI and developers | deployer user + project token |
| Deploy review (`review/*`) | reviewers | personal emailed link + login, password and TOTP 2FA |

The library doesn't manage the users of your application. That's the job of your interceptor and
database. The rest of this section is about the built-in consoles.

### 1. Generate a password hash

Monitor and deployer configs store a salted scrypt hash, never the password itself. Run the
command on any machine with the package installed:

```text
$ npx bmfk hash-password

Hash a monitor password  (APIService access.monitor)
Login: ops
Password:                      ← typed input is not shown
Repeat password:

✓ Put this in the config instead of the plain password:

  { "login": "ops", "password": "scrypt$16384$8$1$Rkps…$zrwU…" }
```

- **Deployer users.** For a user in the deployer's `setup.json`, use `npx bmfk hash-password --deployer`.
  The hash differs from a monitor hash, so they can't be swapped.
- **Interactive only.** The password is never accepted as an argument, so it doesn't end up in shell
  history or `ps`. Without a terminal (in CI, for example), the command refuses to run.
- **Password policy.** The minimum length is 12 characters, checked by the command.
- **Salting.** Every run gives a different hash for the same password. All of them are valid.
- **Plain text is refused.** A password stored in plain text is rejected at login with the same answer
  as a wrong password. The server log says why, and a startup error names the affected logins.

Put the result into `access.monitor` (inline or in an `access.json` file) and add a role:

```ts
access: {
  monitor: [{ login: "ops", password: "scrypt$16384$8$1$…", role: "admin" }],
},
projectName: "my-service",              // shown in the authenticator app
monitorAuthDir: "/var/lib/my-service",  // where 2FA enrollments are stored; outside deploy folders
```

### 2. Sign in to the monitor

Open `<baseEndPoint>sm/html` in a browser. The page runs this flow for you. The same flow over the API:

**Step 1. Log in.**

```http
POST /api/sm/login
{ "login": "ops", "password": "…" }
```

**On the first login,** 2FA isn't set up yet, so the response contains an enrollment instead of a
session:

```jsonc
{ "data": {
    "enrollmentRequired": true,
    "enrollmentToken": "…",              // valid for 10 minutes
    "secret": "JBSWY3DPEHPK3PXP",        // for manual entry
    "otpauthUri": "otpauth://totp/my-service:ops?secret=…&issuer=my-service",
    "expiresInMs": 600000 } }
```

**Step 2. Enroll the authenticator (first login only).** Scan `otpauthUri` as a QR code with Google
Authenticator, 1Password, Authy or a similar app, then confirm with the current code:

```http
POST /api/sm/enroll2fa
{ "enrollmentToken": "…", "totp": "123456" }
```

The secret is saved only after a correct code, and the response is already a session (see step 3).

**On later logins,** send the code from the app with the password:

```http
POST /api/sm/login
{ "login": "ops", "password": "…", "totp": "123456" }
```

```jsonc
{ "data": { "token": "…", "login": "ops", "role": "admin",
            "capabilities": ["dashboard", "logs", "admin"],
            "idleTimeoutMs": 900000, "maxLifetimeMs": 28800000, "twoFactor": true } }
```

**Step 3. Call the monitor with the session token.**

```http
POST /api/sm/procinfo
Authorization: Bearer <token>
```

**How sessions behave:**

- **Lifetime.** A session ends after 15 minutes without requests, or after 8 hours in any case.
  `POST sm/logout` ends it at once.
- **Lockout.** 10 failed logins lock the account for 30 minutes.
- **Revocation.** Removing a user from `access`, or changing their password, ends their sessions
  immediately.
- **Restart.** `sm/restart` asks for the password and the TOTP code again, even within a valid session.
- **Errors.** `401` means sign in again; `403` means the role doesn't allow this section.

### 3. Reset a user's 2FA (lost phone)

Re-enrolling through the API is impossible on purpose. Otherwise anyone who learned the password
could attach their own authenticator. To reset:

1. Open `/var/bmfk/<project>/monitor-2fa.json` on the server (with `monitorAuthDir` set:
   `<monitorAuthDir>/monitor-2fa.<projectName>.json`).
2. Delete the user's entry under `projects.<projectName>.users.<login>`.

No restart is needed. The file is watched like `access.json`: within a second the user's sessions
end, and their next login shows a new QR code. Deleting the whole file resets 2FA for every user of
the project in the same way. A broken file (invalid JSON) is ignored, and the current enrollments
stay in force.

> A deleted enrollment means the next person who knows the password enrolls their own
> authenticator. Reset 2FA only after confirming who is asking, and preferably change the password
> at the same time.

Alternatively, set a known base32 secret directly in the config with `totpSecret`. It takes
precedence over the stored enrollment.

### 4. Documentation

Users in `access.documentation` sign in on `<baseEndPoint>doc/html` the way monitor users do: the
password is stored as a hash (`npx bmfk access-config` or `hash-password`), a second factor is set up at
the first sign-in, a session ends after 15 minutes idle and 8 hours at most, and 10 failed sign-ins lock
the account for 30 minutes. `doc/json` answers only with a session token (`Authorization: Bearer
<token>` from `doc/login`). Use `endpoints` to limit what a user sees.

Documentation sessions and monitor sessions are separate: one never opens the other. 2FA enrollments of
documentation users are kept in the same file as the monitor's, under `doc:<login>` — to reset a
partner's 2FA, remove `doc:<login>` from it (see above).

### 5. Deployer

- **Server.** The deployer server keeps `setup.json` users as hashes (`hash-password --deployer`).
- **Addresses.** `allowed_ips` in `setup.json` limits which addresses can use the deployer at all.
- **Client.** The deploying machine keeps the login and either a private key (recommended) or the
  password in `deploy.json`. Either way, the file can deploy on its own: never share it or commit it.
- **What goes over the wire.** With a key, `Authorization: Signature kid=…, ts=…, nonce=…, sig=…`. The
  signature is good for one request and five minutes, and covers the project, the fields and the
  archive. With a password, `Authorization: Bearer sha256(login:password)` and `X-Deployer-Login`.
- **Project token.** Deploying, switching and restoring also require the project's own `token`. The
  project config on the server holds only its hash. Run `npx bmfk project-token`: it prints a new
  random token for `deploy.json` and its hash for the project config. To keep an existing token, run
  `npx bmfk project-token --hash`. A token stored in plain text is refused like a wrong token. The
  server log says why, and a startup error names the affected projects.

---

## WebSocket server

The WebSocket server shares the HTTP port. It listens on `baseEndPoint + endpoint`, for example
`wss://api.example.com/api/v1/ws`:

```ts
getDefaultOptions({
  websocketServer: {
    endpoint: "ws",                 // default "ws"
    authTimeoutMs: 10_000,          // the client must authorize within this time
    onAuthorize: async (connection, message) => {
      // `message` is the client's FIRST message, parsed JSON
      const user = await sessions.find(message?.token);
      return user ?? false;         // false / null → close 4401; an object → connection.auth
    },
    maxPayload: 256 * 1024,         // bytes per message → close 1009
    maxMessagesPerSecond: 20,       // per connection   → close 1008
    maxConnections: 1000,           // total           → HTTP 503
    maxConnectionsPerIp: 50,        // per client IP   → HTTP 429
  },
});
```

```ts
import { S_WS_ON_CONNECTED, S_WS_ON_MESSAGE, S_WS_ON_CLOSE, REQ_WS_SERVER } from "@bmfk/api";

S_WS_ON_CONNECTED.subscribe(conn => conn.send({ hello: conn.auth.name }));
S_WS_ON_MESSAGE.subscribe(({ connection, message }) => { /* … */ });
S_WS_ON_CLOSE.subscribe(conn => { /* … */ });

const ws = await REQ_WS_SERVER.request();
ws?.broadcast({ event: "price" }, c => c.auth.plan === "pro");
```

The client sends credentials as its **first message**, not in the URL, so tokens don't end up in proxy
access logs:

```js
const socket = new WebSocket("wss://api.example.com/api/v1/ws");
socket.onopen = () => socket.send(JSON.stringify({ token }));
```

How connections are handled:

- **Authorization.** Messages sent while authorization is being checked are dropped. A connection that
  doesn't authorize within `authTimeoutMs` is closed with code 4408. This also applies when
  `onAuthorize` itself is too slow.
- **Origin check.** The browser `Origin` is checked as for HTTP (same-origin or `corsHostWhiteList`). This
  prevents cross-site WebSocket hijacking.
- **`onAuthorize` is required.** A server without it does not start, unless `public: true` says on purpose
  that every connection is accepted (a warning is logged at startup).

---

## Deployer and CLI

The deployer is an `APIService` running on the target server with the `deployer` option. It receives a
build, unpacks it, installs dependencies, writes the configuration and starts the process in pm2.

The CLI is `bmfk` (`npx bmfk <command>`).

**On the server**, the quickest start is the wizard — in an empty folder, as the user that will own the
deployed projects (not root):

```bash
npm init -y && npm i @bmfk/api
npx bmfk deployer-init
```

It checks Node, pm2 and `/var/bmfk`, asks for the port, the folders, the first deploy users' public keys
(`npx bmfk deploy-key` prints them on the machine you deploy from), the addresses allowed to deploy and an
optional Telegram chat. It writes `bin/Main.js`, `ecosystem.config.cjs` for pm2 and `setup.json`
(mode `600`), and prints the nginx block (with `client_max_body_size` matching the archive limit) and the
next commands. It asks before replacing anything. What it writes is an ordinary service:

```ts
getDefaultOptions({
  port: 9915,
  fileLimit: 100 * 1024 * 1024,                   // the largest deploy archive
  deployer: {
    projects_path: "/var/bmfk/bmfk-deployer/projects",   // one JSON config per project
    setup_path: "/var/bmfk/bmfk-deployer/setup",         // the folder that holds setup.json
  },
});
```

`setup.json` lists who may deploy. The recommended way is a **signing key** per user. Run
`npx bmfk deploy-key` in the project: it writes an Ed25519 private key into `deploy.json` and prints the
public key to add to the user in `setup.json` (`setup-config` → "set a deployer user's public key").
Every request is then signed. A captured request can't be replayed or changed, the signature covers the
archive's sha256, and the deployer stores no secret at all. Only signed requests are accepted by default;
`"require_signature": false` in `setup.json` also lets users with a password (stored as a hash) in, for
example while they get their keys. The project token is still required on top, so a deploy always proves
which project it is meant for. The easiest way to manage users, reviewers and
allowed addresses is `npx bmfk setup-config <folder>`, a menu that hashes passwords for you; for a
single hash use `npx bmfk hash-password --deployer`. When sign-in fails, the deployer logs why
(unknown login, wrong password, unsigned request, no `X-Deployer-Login`), while the client only gets
`Unauthorized`.

```jsonc
{
  "users": [
    { "login": "ci", "publicKey": "MCowBQYDK2VwAyEA…" },          // signs its requests
    { "login": "igor", "password": "scrypt$16384$8$1$…" }          // password: only with require_signature false
  ],
  "require_signature": false,                     // omit it (default): signed requests only
  "allowed_ips": ["203.0.113.7", "10.8.0.0/24"]   // who may deploy; IPs and CIDR subnets, IPv4/IPv6
}
```

`allowed_ips` is checked before the credentials, for deploy, activate, status, backups and restore.

**Telegram.** With `telegram` in `setup.json` the deployer posts one message per event to a chat: deploy
done, a failed step (backup, unpack, migrate, pm2, nginx, liveness), switch and rollback, restore, a deploy
waiting for review and the review's outcome, readiness lost and back. The message names the project, the
status, the user and the server — never a review link (those are personal) and never config values.

```jsonc
"telegram": { "bot": "<token from @BotFather>", "chat": "-100…", "topic": 12 }   // topic: optional, a forum topic
```

The bot must be a member of the chat. The token is a secret: keep `setup.json` at `600`, and if the token
leaks, revoke it in @BotFather. It is sent only to `api.telegram.org` and never written to logs or the
monitor's journal. Changes apply without a restart; a failed send is logged and never stops a deploy.

Other addresses get `403`. Without the list the deployer accepts any address, and a warning is logged.
`setup.json` is reloaded on change, so the list can be edited without a restart. An invalid entry
rejects the whole change, and the previous setup stays in force.

> **Behind nginx,** pass the real client address: `proxy_set_header X-Real-IP $remote_addr;`. Without
> it, every request appears to come from `127.0.0.1`. Never add `127.0.0.1` to `allowed_ips` on a
> deployer behind a proxy on the same host: that would let every request through.

A project config (`projects_path/<name>.json`). The easiest way to make one is `npx bmfk project-config`:
it asks for everything below, generates the token, takes config values as hidden input, checks the
result against the deployer's schema, and saves the project config and a matching `deploy.json` with
permissions `600`.

```jsonc
{
  "name": "my-service",
  "destination": "/var/node/my-service",
  "token": "scrypt$16384$8$1$…",   // hash of the project token: npx bmfk project-token
  "unpack": true, "install": true, "pm2": true,
  "backup": true,     // copy the current version aside before each deploy (see Backups)
  "migrate": false,   // run `npm run migrate` before the process starts
  "omitDev": false,   // true: install without devDependencies (npm ci --omit=dev)
  "config": { "DB_HOST": "…" }   // substituted into the shipped config placeholders _{{DB_HOST}}_
}
```

The `name` becomes the deployed `package.json` name, the data folder `/var/bmfk/<name>` and part of the
state, backup and secrets file names. So it is restricted: lowercase letters, digits, `.`, `_` and `-`,
starting with a letter or digit, up to 100 characters — for example `api.gateway.example.com`. A
project config with any other name is ignored, with an error in the deployer's log;
`bmfk migrate-configs` lists such configs too.

#### Keeping secrets out of the deployed code

By default, `config` values are written into the shipped files in place of `_{{KEY}}_`. That puts
passwords into the code, into both blue-green slots and into every backup. Add `secrets` to the project
config to avoid this:

```jsonc
"secrets": {}                                   // "secrets_dir" from setup.json, else /var/bmfk/<project>/secrets[-<slot>].json
"secrets": { "dir": "/etc/node-secrets" }       // → /etc/node-secrets/<project>[-<slot>].json
"secrets": { "file": "/etc/node-secrets/my.json" }
```

The deployer writes the values (merged for the slot) into that file, with permissions `600` and
outside the deploy folder, and rewrites each quoted placeholder in `.js` files as a read of the file:

```js
DB_PASSWORD: "_{{db_password}}_"            // in the archive
DB_PASSWORD: (function(k){ … reads /etc/node-secrets/my-blue.json … })("db_password")   // on the server
```

- **No code changes.** The application gets exactly the strings it got before, so `parseInt("_{{port}}_")`
  still works. The file is read once per process.
- **Restarts.** pm2 restarts, `migrate` and cluster workers keep working, because the file stays in place.
- **Backups and restore.** Backups and archives contain only the file path. A restored version reads
  the current values instead of the ones from its deploy.
- **Missing key.** If a key is missing from the file, the start fails with a clear error instead of
  running with a placeholder.
- **Same user.** The secrets file belongs to the deployer's user and is readable only by it. pm2,
  started by the deployer, runs the app as that same user. A project whose pm2 attributes switch the
  user (`--uid`, `--gid`) is refused before anything changes, since the app couldn't read the file.
  The file is also read back before the app is started.
- **Start with a blue-green project.** If the new version fails to start, the inactive slot fails and
  traffic stays on the old one until you `activate`.
- **Fallback to plain substitution.** Values are still written into the file for `.json`, `.env`,
  unquoted placeholders, templates with `${…}`, ES-module projects, and any file that wouldn't compile
  after the rewrite. Each deploy logs which files still hold values.

**In your project**, create `deploy.json` or a `deploy/` folder with one or more configs. Keep it out of
git: it holds credentials.

```jsonc
{
  "name": "my-service",
  "host": "https://deployer.example.com/api/pckg/add",
  "token": "<project token, printed by npx bmfk project-token>",
  "username": "ci",
  "privateKey": "<from npx bmfk deploy-key>",   // or "password": "<your password>"
  "includes": ["certs", { "src": "assets/logo.png", "dest": "bin/logo.png" }],
  "excludes": ["*.map"],
  "bundle": true,         // optional, see below
  "versionBump": false    // optional: keep package.json "version" (default: patch + 1 on every deploy)
}
```

**`"bundle": true`** ships the app's own code as one file instead of the tsc tree in `./bin`. It needs the
bundler in the project: `npm i -D esbuild @babel/parser` (they are optional, so servers don't install them). esbuild
bundles `src/` into the file package.json `"main"` points to (the one pm2 starts, e.g. `bin/Main.js`).
Every package stays a plain `require()`, and the server still runs `npm ci` as usual. Everything else in
`./bin` (html, json, workers) ships as it is, so the slot keeps the same layout and `__dirname` in the
entry file is still `bin/`. `./bin` itself is not changed.

- The entry is derived from `"main"`: `bin/Main.js` → `src/Main.ts`. Override with
  `"bundle": { "entry": "src/Main.ts" }`.
- A `bin/Main.js.map` ships alongside (line mappings only, no source code). The deployer then starts the
  process with `--enable-source-maps` automatically, so stack traces point at the original `src/` lines
  even when the code is one minified file. (If the project ships its own `ecosystem.config.js`, the
  deployer can't edit it and instead logs a reminder to add `node_args: "--enable-source-maps"` yourself.)
  Turn the map off with `"sourcemap": false`; an `excludes` pattern like `*.map` drops it too, and then
  the flag isn't added.
- `"bundle": { "minify": true }` strips comments, renames local variables and collapses whitespace. It
  costs nothing at runtime and makes the shipped file hard to read, so a casual `cat` over `./bin` no
  longer reveals the source. It is **not** a secret-hiding measure: string literals (so any value baked
  into the code) stay in clear text, and anyone running as the process user can still read them from the
  runtime. The real fix for credentials in code is a [secrets file](#keeping-secrets-out-of-the-deployed-code);
  protect the files themselves with `"chmod": 700` and a dedicated OS user.
- The deploy warns, but doesn't stop, about code that behaves differently once it's in one file:
  `__dirname` / `__filename` outside the entry (it becomes `bin/`), a value exported by the entry (such
  as `export const __root = __dirname`) read while modules load rather than inside a function (it's not
  set yet), and `.js` files left in `./bin` that are not part of the bundle.

```json
"scripts": {
  "deploy":   "bmfk deploy",
  "activate": "bmfk activate",
  "status":   "bmfk status",
  "backups":  "bmfk backups",
  "restore":  "bmfk restore"
}
```

| Command | What it does |
|---|---|
| `bmfk wizards` | list every interactive wizard below with what it does, and run one |
| `bmfk deployer-init [folder]` | set up a deployer on this server: service, pm2 file, `setup.json`, nginx block |
| `bmfk deploy [config]` | build and upload the project |
| `bmfk activate [config] [blue\|green]` | switch traffic to a slot (blue-green) |
| `bmfk status [config]` | active and last deployed slot, recent history |
| `bmfk backups [config]` | list backups |
| `bmfk restore [config] [backup] [--yes]` | restore a backup |
| `bmfk hash-password [--deployer]` | hash a password for the monitor or `setup.json` |
| `bmfk project-token [--hash]` | generate a project token and its hash, or hash an existing token |
| `bmfk project-config` | build a project config for the deployer step by step (plus a `deploy.json` skeleton) |
| `bmfk access-config [file]` | create or edit `access.json`: monitor and documentation users, roles, passwords, allowed addresses |
| `bmfk migrate-configs [folder] [--yes]` | hash the secrets of old `setup.json`, project configs and `access.json` files in place |
| `bmfk setup-config [file\|folder]` | edit the deployer's `setup.json`: add, rename or remove users, change passwords, reviewers, allowed IPs |
| `bmfk deploy-key [deploy.json]` | generate a signing key: private key into `deploy.json`, public key for `setup.json` |

To pass a config path through npm, use `--`: `npm run deploy -- deploy/prod.json`.

**Safety of the deploy pipeline:**

- Archives are checked before unpacking: absolute paths, `..`, and symlinks that point outside the
  destination are rejected.
- Unsafe destinations are refused: relative paths, the filesystem root, top-level system folders
  (`/var`, `/etc`…), the deployer's own folders, and a folder whose wipe would delete another project.
- Dependencies are installed with `npm ci --ignore-scripts`. `migrate` is the only script the deployer
  runs. With `"omitDev": true` in the project config, devDependencies (TypeScript, test tools, the
  bundler) are not installed on the server at all. Check first that `npm start` and `npm run migrate`
  need nothing from devDependencies — `ts-node` in a migrate script, for example.
- Every deploy, switch and restore needs a deployer user and the project token. Both are stored on
  the server only as hashes.
- `allowed_ips` limits which addresses can reach the deployer at all.
- With [deploy review](#deploy-review), uploads wait for approval by reviewers who sign in with a
  password and 2FA.

---

## Blue-green deployments

Blue-green gives you releases without downtime and rollbacks in seconds.

### The idea

A project has **two slots**, `blue` and `green`. Each slot is its own folder and its own pm2 process on its
own port. nginx sends traffic to **one** slot at a time.

```
                ┌──────────── nginx ────────────┐
   clients ───▶ │  upstream → active slot port  │
                └───────┬───────────────┬───────┘
                        ▼               ┆ (no traffic)
               my-service-blue    my-service-green
                 :8055 (live)       :8056 (standby)
```

1. **`deploy`** puts the new version into the **inactive** slot and starts it. Production is not touched,
   and you can test the new slot directly on its port.
2. **`activate`** points nginx to that slot and reloads nginx. The switch is instant.
3. **Rollback** is `activate` back to the other slot. The previous version is still running, so a
   rollback takes seconds.

The very first deploy creates `blue` and makes it active right away.

### Configuring a project

Add `bluegreen` and `nginx` blocks to the project config on the deployer:

```jsonc
{
  "name": "my-service",
  "destination": "/var/node/my-service",      // slots go to …/blue and …/green
  "token": "scrypt$…", "unpack": true, "install": true, "pm2": true, "backup": true,

  "config": { "DB_HOST": "…" },               // shared by both slots

  "bluegreen": {
    "blue_config":  { "port": "8055" },        // per-slot values; the ports must differ
    "green_config": { "port": "8056" },
    "on_switch": ["/usr/sbin/nginx", "-s", "reload"]   // runs after each switch (absolute path)
  },

  "nginx": {
    "config_dir": "/etc/nginx/node-projects",  // nginx must include <config_dir>/*.conf
    "domain": "api.example.com"
  }
}
```

The deployer manages two nginx files per project:

- **`<name>.upstream.conf`** holds only the active port. The deployer rewrites it on every switch.
- **`<name>.server.conf`** is the server block. The deployer creates it once, and after that it belongs
  to you: add SSL with `certbot --nginx -d <domain>`, extra locations and so on. The deployer never
  overwrites it. The generated block already passes `X-Real-IP` and the WebSocket upgrade headers.

### Workflow

```bash
npm run deploy                 # new version → inactive slot (e.g. green), production unchanged
npm run status                 # "green is deployed but NOT switched"
npm run activate               # traffic → green
npx bmfk activate blue      # rollback → blue
```

### Is my process live? (in the application)

Both slots run at the same time. Work that must happen once, such as cron jobs, queue consumers and
mailings, should run **only in the live slot**:

```ts
APIService.onLiveChange(live => {
  if (live) startCrons();
  else      stopCrons();      // this slot was switched to standby
});

if (APIService.isLive) { … }  // synchronous: true / false / null (not known yet)
```

| Situation | `live` |
|---|---|
| Project not on blue-green | `true`, always |
| Blue-green, my slot is active | `true` |
| Blue-green, my slot is standby | `false` |
| Not known yet | `null`; the callback isn't called until the answer is known |

The same code works before and after a project moves to blue-green. Without blue-green, the callback is
called once with `true`.

**How it works.** On deploy, each slot gets a `.bluegreen.json` file (mode `600`) with the project name,
the slot and a **read-only status token**. The app asks the deployer over loopback every
`blueGreenWatchMs` (default 5 s) which slot is active, so a switch is seen within seconds without a
restart.

**If the deployer is unreachable,** the last known value is kept (`stale: true`), and the app is never
switched to standby because of an error. The status token only allows reading the active slot. Deploy
credentials never reach the application.

### Two things to keep in mind

- **The database is shared by both slots.** The new version starts before the switch, and after a
  rollback the old version works with the database again. Schema migrations must be
  **backward-compatible**: add first, remove in a later release. Neither `activate` nor `restore` rolls
  back the schema.
- **Moving an existing project to blue-green.** Use ports different from the current one. After the
  first blue-green deploy, stop the old process (`pm2 delete <name>`, then `pm2 save`). The old process
  has no `.bluegreen.json`, so it would consider itself live, and singleton work would run twice.

---

## Backups and restore

With `"backup": true`, the deployer copies the destination aside before every deploy, for example to
`/var/node/my-service/2026-10-14_18-45-09-my-service-blue`. It works for blue-green and regular projects.

- **Complete copies.** A backup includes `node_modules`, permissions and symlinks, so a restore needs no
  network and no `npm ci`.
- **Retention.** The last 10 backups per project are kept.
- **Fail-closed.** If the backup fails (disk full, no permissions), the deploy stops without changing
  anything.

```bash
npm run backups                                         # list: version, slot, who, when, size
npm run restore                                         # pick one interactively, confirm
npx bmfk restore 2026-10-13_10-00-00-my-service-blue --yes   # non-interactive (CI)
```

How a restore works:

- It first backs up the current state, so a bad restore can be undone.
- It swaps the folders atomically and restarts the pm2 process.
- Restoring the active slot (or a regular project) goes live immediately, and the CLI warns about it.
  Restoring a standby slot changes nothing until you `activate` it.

Configuration values are baked in at deploy time. A restored version comes back with the secrets it was
deployed with, unless the project uses a [secrets file](#keeping-secrets-out-of-the-deployed-code).

---

## Deploy review

A project can require approval before anything reaches the server. The upload is held, each reviewer
gets a personal link by email, and the deploy runs only after approval. That way stolen deploy
credentials alone can't change production.

### Setup

Reviewers are defined in the deployer's `setup.json`. Their passwords are hashes made with
`npx bmfk hash-password`, and they set up 2FA at the first sign-in. `review_url` is the address of
the review page, as reviewers reach it:

```jsonc
{
  "reviewers": [
    { "login": "lead", "password": "scrypt$16384$8$1$…", "email": "lead@example.com" },
    { "login": "cto",  "password": "scrypt$16384$8$1$…", "email": "cto@example.com" }
  ],
  "review_url": "https://deployer.example.com/api/review/html",
  "notifier": { "URL": "…", "KEY": "…" },      // sends the emails
  "allowed_ips": ["10.8.0.0/24"]              // the review page is behind it too, e.g. the VPN range
}
```

A project opts in from its config:

```jsonc
"review": { "reviewers": ["lead", "cto"], "mode": "all", "ttlHours": 24 }
```

- **`mode`.** With `"any"`, one accept is enough; with `"all"`, every reviewer must accept. Either
  way, a single decline rejects the upload.
- **`ttlHours`.** How long the links stay valid: 1 to 168 hours, 24 by default.

If a project's review can't work (an unknown reviewer, no `review_url`, no notifier), the deployer says
so at startup and refuses that project's uploads until it is fixed.

### How it works

1. **`bmfk deploy`** uploads as usual. The archive goes through all the usual checks and is then
   held. The CLI prints `WAITING FOR REVIEW`, and production is untouched.
2. **Each reviewer gets an email** with a personal link. The link alone is not enough: it opens a
   sign-in with login, password and a 2FA code.
3. **The page shows the changes** compared with the last deployed version: version before and
   after, dependency changes in `package.json`, and added, removed and changed files with a
   line-by-line diff.
4. **Accept** runs the normal deploy (backup, migrations, pm2, nginx) from the stored archive, after
   checking that its SHA-256 still matches what the reviewers saw. For blue-green, the new version
   lands in the inactive slot, and `bmfk activate` still switches traffic. **Decline** deletes the
   archive.
5. **A new upload** replaces the pending one. Every old link and every open review session stop
   working, and reviewers get new links.

Undecided uploads expire after `ttlHours`, and their archive is removed.

### What the diff shows and hides

The comparison uses the **raw archives**: the stored archive of the last successful deploy and the
new one. Deployed folders are never read, because config values (passwords) are substituted there.
Files such as `.env*`, `*.pem` and `*.key` are listed, but their content is never shown. Binary and
very large files are listed with their sizes. The first reviewed deploy of a project has nothing to
compare with, so every file is shown as added.

### Security notes

- **Personal links.** A link works only for the reviewer it was sent to. The token is in the URL
  fragment (`#…`), which never reaches the server logs, and the page removes it from the address bar.
- **Sessions.** A session lasts 15 minutes without activity and 1 hour at most. It is bound to one
  upload: a new upload ends it.
- **Lockout.** 10 failed sign-ins lock the reviewer for 30 minutes.
- **Mail scanners.** Opening the link changes nothing. Accept and decline need a signed-in click, so
  a mail scanner that "visits" links can't approve anything.
- **Separation of duties.** Give the review to someone other than the person who deploys. That's
  what change control (for example PCI DSS 6.5) expects.

### Audit trail and maintenance

All review data lives in `<projects_path>/.review/`, with permissions `600`:

| File | Content |
|---|---|
| `<project>.history.jsonl` | every upload, decision and result, with IP addresses and the archive SHA-256 |
| `<project>.pending.*` | the archive waiting for review and its state |
| `<project>.last.tgz` | the raw archive of the last successful deploy, the "before" of the next diff |
| `reviewers-2fa.json` | reviewers' 2FA enrollments |

To reset a reviewer's 2FA, delete their entry from `reviewers-2fa.json`. It is read at every sign-in,
so no restart is needed.

---


### Data folder

What has to survive restarts and deploys lives in one folder per project, outside the deployed code:

```
/var/bmfk/<project>/
  metrics/            metrics history: the current week per minute, 10 weeks in all
  threats.json        what the threat monitor has seen (addresses, user agents, URLs — never bodies)
  blocked-ips.json
  access.json         monitor and documentation users (option `access: ""`, the default)
  monitor-2fa.json    monitor 2FA enrollments
  uploads/            uploaded files while their request runs
  secrets[-<slot>].json  config values the deployer keeps out of the code (`"secrets": {}`)
```

- **The project name is the deployer's.** On every deploy the deployer writes its project name into
  the deployed `package.json` (and `package-lock.json`) `"name"`, and the app takes it from there. One
  source tree deployed as several projects gets a folder per project; the two blue-green slots of one
  project share theirs. Your repository's `package.json` is not changed. Off the deployer, the
  `package.json` name is used as is. (`projectName` stays what the authenticator app shows.)
- **One writer.** Only the live process writes metrics and threats: a blue-green standby and pm2 cluster workers
  other than instance 0 count in memory only. A slot that becomes live loads what the other slot wrote,
  so charts continue across deploys.
- **Rights.** The app creates its folder (`0700`). If it can't create `/var/bmfk` — say, the app runs as
  an unprivileged user — it says so at startup and falls back to a folder beside the code. Create the
  root once: `sudo mkdir /var/bmfk && sudo chown <app user> /var/bmfk`.
- `BMFK_DATA_DIR` moves the root. Each file can still be set on its own: `metricsDir` (`false` keeps
  metrics in memory), `blockedIps.file`, `monitorAuthDir` / `monitorAuthFile`.

## Options reference

| Option | Default | Description |
|---|---|---|
| `port` | `8080` | HTTP port |
| `baseEndPoint` | `"/api/"` | prefix for all endpoints |
| `projectName` | `"Application project"` | shown in the monitor and as the 2FA issuer, so set it |
| `endpoints` | `[]` | your `BaseEndpoint` instances |
| `corsHostWhiteList` | `[]` | browser origins allowed besides the API's own; `"*"` allows any, without credentials |
| `isProductionEnvironment` | `true` unless `NODE_ENV=development` | production mode |
| `interceptor` | — | authentication for your endpoints |
| `preproducer` / `postproducer` | — | hooks before the handler / before the response is sent |
| `access` | `""` → `/var/bmfk/<project>/access.json` | a path to a JSON file reloaded on change, or `{ monitor, documentation, monitorAllowedIps }` |
| `monitorAuthDir` / `monitorAuthFile` | `/var/bmfk/<project>/monitor-2fa.json` | where 2FA enrollments are stored |
| `metricsDir` | `/var/bmfk/<project>/metrics` | metrics history, 10 weeks; `false` → in memory only |
| `logFiles` | pm2 auto-detected | log files the monitor may tail (for example nginx) |
| `threatMonitoring` | `true` | probe and scan detection; observation only |
| `trustedProxies` | loopback | proxies whose `X-Real-IP` / `X-Forwarded-For` are trusted |
| `blockedIps` | `/var/bmfk/<project>/blocked-ips.json` | `{ file, message }` for the blocked-address list; `false` turns it off |
| `websocketServer` | — | enables the WebSocket server, see above |
| `deployer` | — | turns this service into a deployer |
| `blueGreenWatchMs` | `5000` | how often to check the active slot; `0` disables |
| `jsonLimit` | `"10mb"` | maximum JSON / form body |
| `fileTempDir` / `fileLimit` | `<data folder>/uploads` (mode 700) / 10 MB | uploads |
| `keepAliveTimeout` / `headersTimeout` | 25 s / 26 s | HTTP server timeouts |
| `appVersion` | — | returned in every response as `version` |

---

## Security

### What you get by default

- **Credentials.** Monitor and deployer passwords are stored as salted scrypt hashes, and plain text in
  configs is refused. Comparisons run in constant time. Verifying a deployer request costs at most one
  scrypt computation, so the deployer can't be used to burn CPU.
- **Monitor access.** Mandatory TOTP 2FA, short-lived sessions, account lockout, roles, and the password
  asked again before a restart.
- **Data in logs.** Card data and secrets are redacted when logs are written and when they are viewed
  through the monitor. Logged objects are never modified.
- **Client IP.** Proxy headers are trusted only from `trustedProxies`, so clients can't spoof their
  address.
- **Deploys.** Archives are checked for path traversal and escaping symlinks, package install scripts
  are disabled, and every deploy needs a user and the project token. Requests are signed with Ed25519
  (the deployer keeps only public keys), so they can't be replayed or altered.
- **Blue-green.** Applications get a read-only status token; deploy credentials never reach them.
- **WebSocket.** Origin checks, authorization within a time limit, and limits on message size, message
  rate and connections. A malformed frame can't crash the process.
- **Built-in endpoints.** The monitor and deployer endpoints are hidden from the API documentation.

### What you must configure before going to production

1. List your other front-end origins in `corsHostWhiteList` (the API's own origin is always allowed;
   behind nginx pass the host: `proxy_set_header Host $host;`).
2. Store all monitor and deployer passwords as hashes (`npx bmfk hash-password`).
3. Point `monitorAuthDir` to a persistent directory outside the deploy folders, readable only by the
   service user.
4. Run behind nginx (or another proxy) on loopback with TLS, and keep `trustedProxies` at its default
   unless the proxy runs on another host.
5. If you use WebSockets, set `onAuthorize` (required unless `public: true`).
6. Keep `deploy.json` / `deploy/` out of version control, and restrict permissions on `setup.json` and
   the project configs on the server.
7. Set a meaningful `projectName`, which is shown in authenticator apps.

### What this library does not do

- **It is not a WAF.** Threat monitoring records suspicious clients but never blocks them. Use nginx
  rate limiting, fail2ban or a WAF for blocking.
- **It doesn't make your system PCI DSS compliant on its own.** It helps with some requirements
  (redaction, MFA, access roles, audit logs), but compliance is assessed for your whole environment.
- **Redaction is pattern-based.** Treat it as a safety net, not a substitute for not logging sensitive
  data.

---
---

## License

MIT
