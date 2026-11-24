import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { InterceptorPayAuth } from "../src/apiServer/interceptors/InterceptorPayAuth";

const KEY = "00112233445566778899aabbccddeeff";
const PATH = "/api/v1/payments/refund";

function request(authorization: string, b64: string, path = PATH, method = "POST") {
    return { method, headers: { authorization }, data: { b64 }, raw: { originalUrl: path } } as any;
}

const auth = (v1?: boolean) => new InterceptorPayAuth([{ kid: "k", key: KEY, ...(v1 === undefined ? {} : { v1 }) }]);
const b64Of = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64");
const hmac = (message: string) => crypto.createHmac("sha256", Buffer.from(KEY, "hex")).update(message).digest("hex");
const header = (v: number, ts: string, nonce: string, sig: string, kid = "k") => `PayAuth v=${v}, ts=${ts}, nonce=${nonce}, kid=${kid}, alg=hmac-sha256, sig=${sig}`;
const nonce = () => crypto.randomBytes(12).toString("base64url");
// A v1 request, as existing clients make it: HMAC(b64 + ts + nonce).
const v1 = (data: unknown, ts = String(Date.now()), n = nonce()) => { const b64 = b64Of(data); return { authorization: header(1, ts, n, hmac(b64 + ts + n)), b64 }; };

async function refused(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e: any) { return String(e?.details); }
    assert.fail("request was accepted");
}

test("a key that isn't hex fails at construction", () => {
    assert.throws(() => new InterceptorPayAuth([{ kid: "k", key: "ABEiM0RVZneImaq7zN3u/w==" }]), /"k".*hex/);
});

test("a key shorter than 16 bytes fails at construction, an empty one too", () => {
    assert.throws(() => new InterceptorPayAuth([{ kid: "k", key: "00112233445566778899aabbccddee" }]), /16 bytes/);
    assert.throws(() => new InterceptorPayAuth([{ kid: "k", key: "" }]), /16 bytes/);
});

test("a key that isn't hex, given per call, refuses the request instead of signing with an empty key", async () => {
    // Buffer.from(<base64>, "hex") is empty: a signature made with an empty key must not pass.
    const forged = InterceptorPayAuth.sign({ key: "", kid: "k", method: "POST", url: PATH, data: { amount: 100 } });
    const p = new InterceptorPayAuth().intercept(request(forged.authorization, forged.b64), [{ kid: "k", key: "ABEiM0RVZneImaq7zN3u/w==" }]);
    assert.match(await refused(p), /key/i);
});

test("v2: a request made by sign() is accepted, a replay is refused", async () => {
    const a = auth();
    const { authorization, b64 } = InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: "https://api.example.com" + PATH, data: { amount: 100 } });
    assert.match(authorization, /^PayAuth v=2, /);
    assert.equal((await a.intercept(request(authorization, b64))).kid, "k");
    assert.match(await refused(a.intercept(request(authorization, b64))), /Duplicate nonce/);
});

test("v2: ts in seconds is refused even when correctly signed", async () => {
    const b64 = b64Of({}), ts = String(Math.floor(Date.now() / 1000)), n = nonce();
    const sig = hmac(InterceptorPayAuth.message("POST", PATH, "k", ts, n, b64));
    assert.match(await refused(auth().intercept(request(header(2, ts, n, sig), b64))), /13 digits/);
});

test("v2: the v1 message is not a valid v2 signature", async () => {
    const b64 = b64Of({ amount: 100 }), ts = String(Date.now()), n = nonce();
    assert.match(await refused(auth().intercept(request(header(2, ts, n, hmac(b64 + ts + n)), b64))), /Signature mismatch/);
});

test("v2: another path, method or body breaks the signature", async () => {
    const s = () => InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: PATH, data: { amount: 100 } });
    let r = s();
    assert.match(await refused(auth().intercept(request(r.authorization, r.b64, "/api/v1/payments/payout"))), /Signature mismatch/);
    r = s();
    assert.match(await refused(auth().intercept(request(r.authorization, r.b64, PATH, "PUT"))), /Signature mismatch/);
    r = s();
    assert.match(await refused(auth().intercept(request(r.authorization, b64Of({ amount: 100000 })))), /Signature mismatch/);
});

test("v2: the kid is signed — the same signature under another kid with the same key is refused", async () => {
    const a = new InterceptorPayAuth([{ kid: "k", key: KEY }, { kid: "k2", key: KEY }]);
    const { authorization, b64 } = InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: PATH, data: {} });
    const other = authorization.replace("kid=k,", "kid=k2,").replace(/nonce=[\w-]+/, "nonce=" + nonce());
    assert.match(await refused(a.intercept(request(other, b64))), /Signature mismatch/);
});

test("v1 still works for existing clients: seconds and milliseconds", async () => {
    const ms = v1({ a: 1 });
    assert.equal((await auth().intercept(request(ms.authorization, ms.b64))).kid, "k");
    const sec = v1({ a: 2 }, String(Math.floor(Date.now() / 1000)));
    assert.equal((await auth().intercept(request(sec.authorization, sec.b64))).kid, "k");
});

test("v1: ts digits moved into the nonce don't make a new valid request (the signature is remembered)", async () => {
    const a = auth();
    const ts = String(Date.now()), n = nonce(), b64 = b64Of({ amount: 100 });
    const sig = hmac(b64 + ts + n);
    assert.equal((await a.intercept(request(header(1, ts, n, sig), b64))).kid, "k");
    // Same signed bytes: ts loses its last three digits, the nonce gains them.
    const shifted = header(1, ts.slice(0, 10), ts.slice(10) + n, sig);
    assert.match(await refused(a.intercept(request(shifted, b64))), /Duplicate nonce/);
});

test("v1 and v2: a request accepted by one endpoint can't be replayed against another", async () => {
    const r = v1({ amount: 100 });
    assert.equal((await auth().intercept(request(r.authorization, r.b64, PATH))).kid, "k");
    assert.match(await refused(auth().intercept(request(r.authorization, r.b64, "/api/v1/payments/payout"))), /Duplicate nonce/);
});

test("v1 can be turned off per key; v2 still works for it", async () => {
    const r = v1({});
    assert.match(await refused(auth(false).intercept(request(r.authorization, r.b64))), /v1 is turned off/);
    const s = InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: PATH, data: {} });
    assert.equal((await auth(false).intercept(request(s.authorization, s.b64))).kid, "k");
});

test("an unknown version is refused", async () => {
    const b64 = b64Of({}), ts = String(Date.now()), n = nonce();
    assert.match(await refused(auth().intercept(request(header(3, ts, n, hmac(b64 + ts + n)), b64))), /Unsupported version/);
});
