# Migrating from the legacy API server (6.x) to @bmfk/api 1.0

@bmfk/api grew out of an earlier, unscoped API server package (6.x), called "legacy" below. This page is
for projects that still run on it. New projects can skip it.

## No mixing

1.0 does not talk to the legacy server in any way. Signatures use new labels (`bmfk-sig-v1`,
`bmfk-ms-answer-v1`) and the microservice protocol is `v: 1`, so a 6.x service and a 1.0 service can't call
each other, even with signed calls. A 1.0 project needs a 1.0 deployer (the 6.x deployer rejects its signed
deploys). Backups are marked `.bmfk-backup.json`: a 1.0 deployer does not list 6.x backups.

Move a group of services that call each other together, and set up a 1.0 deployer (new folders) next to
the old one.

## Quick start

```bash
npx bmfk migrate            # shows what it will change and what is left to you
npx bmfk migrate --write    # applies it
npm install && npx tsc --noEmit
```

It rewrites `package.json` (the legacy dependency and its signal package, the legacy CLI and
`node -e 'require(…).Deploy(…)'` scripts) and every import/require of the legacy package (root or `dist/…`)
and of its signal package into `@bmfk/api`. It lists by file and line what it can't do: names 1.0 does not
export, `securityKey`, `new Signal(name, …)` with more arguments. On real projects, after `--write` the only
compile errors left were the `securityKey` lines it listed.

## Imports: one entry point

`package.json` `exports` closes every path except the root: `@bmfk/api/dist/…` no longer resolves
(`ERR_PACKAGE_PATH_NOT_EXPORTED`). Everything projects took from `dist/…` is exported from `@bmfk/api`
(`BaseService`, `IInterceptor`, `REQ_DB`, `LOG_LEVEL`, `getDefaultLogOptions`, `REQ_MICROSERVICE_CALL`, …).
`DefaultErrors` is a named export: `import { DefaultErrors } from "@bmfk/api"`.

## Packages

The legacy server package becomes `@bmfk/api`. The separate signal package is gone: `Signal` and `Req`
come from `@bmfk/api`.

## Signals (`Signal`, `Req`)

`import Signal, { Req } from "<legacy signal package>"` → `import { Signal, Req } from "@bmfk/api"`.

Kept: `new Signal<T>(name?)`, `subscribe(cb, id?)`, `unsubscribe(id)`, `removeAll()`, `invoke(data)`, `name`;
`new Req<T, K>(worker?, name?)`, `listener = …`, `request(data)`, `name`.

Changed:
- A subscriber that throws no longer breaks the signal. Before, the signal stayed "busy" and every later
  `invoke` was silently dropped; now the error goes to `Signal.onError` (stderr) and the others still run.
- `unsubscribe` returns `true` when it removed something (it always returned `false` before).
- `Req.request()` without a worker returns a rejected promise instead of throwing synchronously.
- New: `Signal.size`, `Req.hasListener`.

Removed:
- React hooks: `use`, `useSignal`, `useValue`, `useRequest`, `setupReact`. Frontends keep their own.
- `Binder`, `DataProvider` (the one from the legacy signal package), `SignalHandler`, and the global functions
  `s_subscribe`, `s_subscribeOnce`, `s_unsubscribe`, `s_invoke`, `s_invokeOnce`, `s_removeAll`, `s_destroy`.
- `Signal` constructor arguments `onSubscribe` and `handler`, `Signal.onLog`, `getSubscribtions()`, `type`.

## Microservices: signed calls only

The shared-key mode (v1, `securityKey`) is gone, on both sides.

- `MicroserviceHost`: `clients` and `privateKey` are required. `securityKey` and `password` are removed.
- `MicroserviceClient`: `kid`, `privateKey` and `hostPublicKey` are required. `securityKey` and `password`
  are removed.
- A v1 call reaching a 1.0 host gets `401`.

## ExternalService: removed

`ExternalService`, `REQ_EXTERNAL_CALL`, `REQ_XT` and the endpoint `/external/call/:id` (it was mounted in
every app, without interceptors) are removed. Use `MicroserviceHost` / `MicroserviceClient`.

## MySQL credentials prefixed with "_": no longer decrypted

6.x decrypted `host`, `user`, `database` and `password` starting with `_` using a key built into the public
package, so anyone could decrypt them. 1.0 uses every value as written. Put the real values in the
deployer's secrets file (project config `"secrets": {}`) instead.

## resultModel

Unchanged: documentation only (the `returns` block of the API documentation). The response is not
validated or filtered.

## CLI

The legacy command name is gone; use `bmfk` (`"deploy": "bmfk deploy"`).

## IRequest / IResponse

`HTTPRequestVO` is now `IRequest`, `TransferPacketVO` is `IResponse`. The old names still compile (they
extend the new ones) and are marked `@deprecated`, so editors strike them through; rename when convenient.

## Safer defaults

| Setting | legacy 6.x | 1.0 |
|---|---|---|
| `corsHostWhiteList` | `["http://localhost:3000"]` + `http://localhost:<port>` added | `[]`; the API's own origin (Origin host = `Host`) is always allowed |
| `"*"` in `corsHostWhiteList` | any origin, **with** credentials | any origin, without credentials |
| `isProductionEnvironment` | `false` | `true` unless `NODE_ENV=development` |
| WebSocket without `onAuthorize` | public, a warning | does not start; `public: true` to allow |
| deployer `require_signature` | `false` | signed only; `"require_signature": false` lets password users in |
| `fileTempDir` | `/tmp` | `/var/bmfk/<project>/uploads` (0700) |

Behind nginx, pass the host so same-origin calls (the monitor, your own front end on the API's domain)
are recognised: `proxy_set_header Host $host;`. Otherwise list the front-end origin in
`corsHostWhiteList`.

## Errors the client sees

6.x sent the cause of a failure to the client: the exception text, the database's message (table names,
parts of the query), and an error's `stack`. In production (the default) 1.0 sends only the code and a
generic message: `INTERNAL_SERVER_ERROR` (code 14, was 10002) or `DB_ERROR`; the cause is logged under the
same trace id. An `IError` you throw or return goes out as it is, minus `stack`. With
`NODE_ENV=development` the details come back as before.

Logging: a thrown `IError` below 500 (bad input, refused) is no longer logged as ERROR + CRIT — the request
journal has it. An unexpected exception is one CRIT line with its stack.

## access: a file in the data folder by default

The default of `access` is now `""`: the service reads `/var/bmfk/<project>/access.json` and re-reads it on
change. Without the file the monitor and the documentation are closed (6.x: an empty inline object, also
closed). Projects that set `access` keep what they set.

## Validation: a number sample is no longer a bound

6.x took a non-zero number in a model as a bound: `amount: 100` meant "at most 100", `amount: -5` "at least
5". This was nowhere documented. 1.0 takes the sample only as the type; bounds are `min` / `max`.

`bmfk migrate` rewrites such fields to keep the old behaviour: `amount: 100` → `amount: 0, $__amount_max: 100`
(and `-5` → `0, $__x_min: 5`), in every object literal that is a model — the value of `validationModel`, a
constant it names in the same file, any literal with `$__` keys. It needs TypeScript 5 in the project as
the parser (`npm i -D typescript@5` if it says so). A field that also has `min`/`max` is listed instead:
6.x applied both, so the stricter one was in force — check it by hand. At startup the service also lists
every number sample without `min`/`max`, per endpoint.

For example, `priority: 100, $__priority_max: 1000` is listed: 6.x allowed at most 100, 1.0 as written
allows at most 1000. Decide which one you meant.

## API documentation: real sign-in

6.x documentation users had plain-text passwords in `access.json` and the page sent a never-expiring
`Bearer sha256(login:password)`. 1.0 signs them in like monitor users: password hash, 2FA at the first
sign-in, sessions (15 min idle, 8 h max), lockout after 10 failures; `doc/json` needs a session token.

- Hash the passwords in place: `npx bmfk migrate-configs <folder with access.json>` (now covers
  `documentation[]` too). A plain-text documentation password is refused at sign-in and named in the log.
- Partners enroll an authenticator at their next sign-in; tell them before the switch.
- A script that fetched `doc/json` with `sha256(login:password)` stops working: it has to sign in (with TOTP)
  or read the documentation another way.
- Logins can no longer contain `:` (monitor and documentation).
