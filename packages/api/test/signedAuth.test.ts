import { test } from "node:test";
import assert from "node:assert/strict";
import { InterceptorSignedAuth } from "../src/apiServer/interceptors/InterceptorSignedAuth";

const keys = InterceptorSignedAuth.generateKeyPair();
const other = InterceptorSignedAuth.generateKeyPair();
const URL_ = "https://api.example.com/api/v1/payments/refund";

// What the server sees for a JSON POST: Express's req, as InterceptorSignedAuth reads it.
function request(authorization: string, body: any, path = "/api/v1/payments/refund") {
    return { method: "POST", headers: { authorization }, data: body, raw: { originalUrl: path, body, query: {} } } as any;
}

const auth = () => new InterceptorSignedAuth(kid => (kid === "partner" ? keys.publicKey : null));

test("a correctly signed request is accepted with its key id", async () => {
    const body = { paymentId: 7, amount: 100 };
    const h = InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "partner", method: "POST", url: URL_, data: body });
    assert.deepEqual(await auth().verify(request(h, body)), { present: true, kid: "partner" });
});

test("a changed field breaks the signature", async () => {
    const h = InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "partner", method: "POST", url: URL_, data: { amount: 100 } });
    const v = await auth().verify(request(h, { amount: 100000 }));
    assert.equal(v.kid, undefined);
    assert.match(v.error!, /does not match/);
});

test("another path breaks the signature", async () => {
    const h = InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "partner", method: "POST", url: URL_, data: {} });
    const v = await auth().verify(request(h, {}, "/api/v1/payments/payout"));
    assert.equal(v.kid, undefined);
});

test("a key that isn't the kid's is refused", async () => {
    const h = InterceptorSignedAuth.sign({ privateKey: other.privateKey, kid: "partner", method: "POST", url: URL_, data: {} });
    assert.equal((await auth().verify(request(h, {}))).kid, undefined);
});

test("an unknown kid is refused", async () => {
    const h = InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "stranger", method: "POST", url: URL_, data: {} });
    const v = await auth().verify(request(h, {}));
    assert.match(v.error!, /unknown key id/);
});

test("the same signed request is accepted once", async () => {
    const a = auth();
    const h = InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "partner", method: "POST", url: URL_, data: {} });
    assert.equal((await a.verify(request(h, {}))).kid, "partner");
    const again = await a.verify(request(h, {}));
    assert.equal(again.kid, undefined);
    assert.match(again.error!, /replayed/);
});

test("a nonce isn't burnt by a request with a bad signature", async () => {
    const a = auth();
    const good = InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "partner", method: "POST", url: URL_, data: { x: 1 } });
    // Same header, different body: rejected, and must not spend the client's nonce.
    assert.equal((await a.verify(request(good, { x: 2 }))).kid, undefined);
    assert.equal((await a.verify(request(good, { x: 1 }))).kid, "partner");
});

test("a request signed too long ago is refused", async () => {
    const realNow = Date.now;
    try {
        Date.now = () => realNow() - 10 * 60 * 1000;
        const h = InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "partner", method: "POST", url: URL_, data: {} });
        Date.now = realNow;
        const v = await auth().verify(request(h, {}));
        assert.match(v.error!, /out of window/);
    } finally { Date.now = realNow; }
});

test("no Signature header is reported as absent, a broken one as present", async () => {
    assert.deepEqual(await auth().verify(request("Bearer abc", {})), { present: false });
    const v = await auth().verify(request('Signature kid="partner"', {}));
    assert.equal(v.present, true);
    assert.equal(v.kid, undefined);
});

test("publicKeyOf matches the generated pair", () => {
    assert.equal(InterceptorSignedAuth.publicKeyOf(keys.privateKey), keys.publicKey);
});
