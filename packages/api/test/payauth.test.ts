import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { InterceptorPayAuth } from "../src/apiServer/interceptors/InterceptorPayAuth";

const KEY = "00112233445566778899aabbccddeeff";
const PATH = "/api/v1/payments/refund";

function request(authorization: string, b64: string, path = PATH, method = "POST") {
    return { method, headers: { authorization }, data: { b64 }, raw: { originalUrl: path } } as any;
}

const auth = () => new InterceptorPayAuth([{ kid: "k", key: KEY }]);
const b64Of = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64");
const hmac = (message: string) => crypto.createHmac("sha256", Buffer.from(KEY, "hex")).update(message).digest("hex");
const header = (ts: string, nonce: string, sig: string, kid = "k") => `PayAuth v=1, ts=${ts}, nonce=${nonce}, kid=${kid}, alg=hmac-sha256, sig=${sig}`;

async function refused(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e: any) { return String(e?.details); }
    assert.fail("request was accepted");
}

test("the old glued message (b64 + ts + nonce) is refused", async () => {
    const b64 = b64Of({ amount: 100 }), ts = String(Date.now()), nonce = "n".repeat(16);
    assert.match(await refused(auth().intercept(request(header(ts, nonce, hmac(b64 + ts + nonce)), b64))), /Signature mismatch/);
});

test("ts in seconds is refused even when correctly signed: one format only", async () => {
    const b64 = b64Of({}), ts = String(Math.floor(Date.now() / 1000)), nonce = "n".repeat(16);
    const sig = hmac(["bmfk-payauth-v1", "POST", PATH, "k", ts, nonce, b64].join("\n"));
    assert.match(await refused(auth().intercept(request(header(ts, nonce, sig), b64))), /13 digits/);
});

test("a request made by sign() is accepted, a replay is refused", async () => {
    const a = auth();
    const { authorization, b64 } = InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: "https://api.example.com" + PATH, data: { amount: 100 } });
    assert.equal((await a.intercept(request(authorization, b64))).kid, "k");
    assert.match(await refused(a.intercept(request(authorization, b64))), /Duplicate nonce/);
});

test("ts digits moved into the nonce don't make a new valid request", async () => {
    const { authorization, b64 } = InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: PATH, data: {}, nonce: "n".repeat(16) });
    const ts = /ts=(\d+)/.exec(authorization)![1];
    const nonce = ts.slice(10) + "n".repeat(16);
    const sig = /sig=([0-9a-f]+)/.exec(authorization)![1];
    assert.ok(await refused(auth().intercept(request(header(ts.slice(0, 10), nonce, sig), b64))));
    assert.match(await refused(auth().intercept(request(header(ts.slice(0, 10) + "000", nonce, sig), b64))), /Signature mismatch/);
});

test("another path, method or body breaks the signature", async () => {
    const s = () => InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: PATH, data: { amount: 100 } });
    let r = s();
    assert.match(await refused(auth().intercept(request(r.authorization, r.b64, "/api/v1/payments/payout"))), /Signature mismatch/);
    r = s();
    assert.match(await refused(auth().intercept(request(r.authorization, r.b64, PATH, "PUT"))), /Signature mismatch/);
    r = s();
    assert.match(await refused(auth().intercept(request(r.authorization, b64Of({ amount: 100000 })))), /Signature mismatch/);
});

test("the kid is signed: the same signature under another kid with the same key is refused", async () => {
    const a = new InterceptorPayAuth([{ kid: "k", key: KEY }, { kid: "k2", key: KEY }]);
    const { authorization, b64 } = InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: PATH, data: {} });
    const other = authorization.replace("kid=k,", "kid=k2,").replace(/nonce=[\w-]+/, "nonce=" + "x".repeat(16));
    assert.match(await refused(a.intercept(request(other, b64))), /Signature mismatch/);
});
