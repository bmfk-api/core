# `auth` block contract

Specification for a **machine-readable authorization descriptor** returned by
`/api/v1/doc/json`. It drives generation of correct code examples (cURL / JS /
PHP) for endpoints protected by the `Payauth` scheme.

It is **separate from** the human-readable prose currently embedded in a group's
`description` (`{"lines":[...]}`). The prose stays for humans; this block is for
the example generator.

---

## 1. Location

Add a top-level `auth` field to the doc response, next to `version` / `core` /
`endpoint`:

```jsonc
{
  "data": [ /* groups */ ],
  "endpoint": "/api/v1/doc/json",
  "version": "0.9.20",
  "core": "4.0.97",
  "auth": { /* AuthBlock — see below */ }
}
```

- A group MAY carry its own `auth` to override the top-level one (optional, for
  later — not required now).
- The block is applied **only** to methods with `"authorized": true`. Methods
  with `authorized: false` get no auth in their examples.

---

## 2. Shape (TypeScript)

```ts
interface AuthBlock {
  scheme: string;          // "Payauth" — label shown in the docs UI
  header: string;          // "Authorization" — HTTP header name to set
  algorithm: string;       // "HMAC-SHA256" — shown + used in snippet comments

  // Header VALUE template. Tokens: any field key from `fields` as {key},
  // plus {sig} for the computed signature.
  format: string;          // "Payauth kid={kid}, sig={sig}, ts={ts}, nonce={nonce}, alg={alg}, v={v}"

  signature: {
    // The exact string that gets HMAC-signed, written the way the SERVER
    // builds and verifies it. Tokens listed in §4.
    base: string;          // "{ts}.{nonce}.{method}.{path}.{bodyHash}"
    encoding: "hex" | "base64";
    bodyHash?: "sha256-hex" | "sha256-base64" | "none"; // how {bodyHash} is derived; default "none"
  };

  // Every field that appears in `format` / `signature.base` (except {sig}).
  fields: Record<string, AuthField>;

  // How the request body is wrapped on the wire (optional).
  body?: {
    wrap: "none" | "base64" | "jwe" | string; // "b64" in the prose == "base64"
    field?: string;        // wrapper property name, e.g. "b64"
    details?: string;      // human note, shown above the example
  };
}

type AuthField =
  | { source: "credential"; placeholder?: string; details?: string } // user-supplied → placeholder in examples
  | { source: "timestamp"; unit: "ms" | "s" }                        // generated at request time
  | { source: "random"; length?: number; charset?: string }          // generated per request (replay protection)
  | { const: string };                                               // fixed value, e.g. "1"
```

---

## 3. Tokens for `format` (header value)

- `{<fieldKey>}` — the value of any key declared in `fields`
  (`{kid}`, `{ts}`, `{nonce}`, `{alg}`, `{v}`).
- `{sig}` — the signature computed from `signature.base`.

---

## 4. Tokens for `signature.base`

Write the base **exactly** as the server constructs it for verification —
order, separators and all. Available tokens:

| Token         | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `{<fieldKey>}`| value of any field (`{ts}`, `{nonce}`, `{kid}`, `{alg}`, `{v}`) |
| `{method}`    | uppercase HTTP method (`POST`)                                  |
| `{path}`      | request path without host (`/api/v1/payment/init`)             |
| `{url}`       | full URL                                                        |
| `{body}`      | request body string as sent (after `body.wrap`)                |
| `{bodyHash}`  | hash of `{body}` per `signature.bodyHash`                      |

> The generator does **not** guess the base. Whatever you put here is what the
> example snippet reproduces. If it's wrong, the examples are wrong — so this is
> the one field to get exactly right.

---

## 5. Full `Payauth` example

```json
{
  "auth": {
    "scheme": "Payauth",
    "header": "Authorization",
    "algorithm": "HMAC-SHA256",
    "format": "Payauth kid={kid}, sig={sig}, ts={ts}, nonce={nonce}, alg={alg}, v={v}",
    "signature": {
      "base": "{ts}.{nonce}.{method}.{path}.{bodyHash}",
      "bodyHash": "sha256-hex",
      "encoding": "hex"
    },
    "fields": {
      "kid":   { "source": "credential", "placeholder": "<KID>", "details": "Key ID provided by the gateway" },
      "ts":    { "source": "timestamp", "unit": "ms" },
      "nonce": { "source": "random", "length": 16 },
      "alg":   { "const": "HMAC-SHA256" },
      "v":     { "const": "1" }
    },
    "body": {
      "wrap": "base64",
      "field": "b64",
      "details": "Encrypt the JSON payload, then base64-encode it into the `b64` field."
    }
  }
}
```

> Replace `signature.base` with the real signing string. The values above for
> `base` / `bodyHash` are a plausible default, **not** confirmed from the server.

---

## 6. How the generator will consume it (per language)

For a method with `authorized: true`:

1. `ts` ← now (per `fields.ts.unit`); `nonce` ← random (`fields.random.length`).
2. Build the request body from the endpoint's `parameters` schema (the logical
   payload). If `body.wrap` is set, also show the wrapped form
   `{ "<body.field>": "<...>" }` and a note from `body.details`.
3. Compute `bodyHash` per `signature.bodyHash`.
4. Build the signing string from `signature.base`.
5. `sig = HMAC_<algorithm>(base, <SECRET>)`, encoded per `signature.encoding`.
6. Assemble the header value from `format`, set header `header`.

The emitted snippet **shows steps 1–6 in code** (with `<SECRET>` / `<KID>`
placeholders) — i.e. a runnable template a developer adapts, not a static
`Bearer` line.

---

## 6a. Generated auth examples in the group Overview

Once the `auth` block is present, the **example** code blocks must be **removed
from the prose** (`description.lines`) — the frontend generates them from `auth`:

- **Header format** — `"<header>: <format>"` with `{token}` placeholders.
- **Header example** — `format` filled with illustrative values (sample `ts` /
  `nonce`, `<KID>` / sample `sig`, const fields verbatim).
- **Body example** — `{ "<body.field>": "<wrap-encoded payload>" }` + `body.details`.

What stays in `description.lines`: the intro sentences and the **parameter
table** (human descriptions of `kid`, `sig`, `ts`, …). What to delete:
`Authorization header example`, `Header example`, `Body example` blocks.

This removes the duplication (and the broken-JSON risk those long code strings
carried).

## 7. Fallback (no `auth` block)

If the response has no `auth` and a method is `authorized: true`, the generator
keeps the current behaviour: `Authorization: Bearer <YOUR_TOKEN>` plus a
`// TODO: auth scheme not described` comment. This keeps the docs working during
the rollout.

---

## 8. Reality check on signatures & body

- The real `sig` cannot be precomputed in public docs (needs the merchant
  secret), and the body can't be truly encrypted client-side. Examples therefore
  show the **construction** with `<SECRET>` and the **logical** payload, plus the
  `body.wrap` note — not a fake valid signature.
