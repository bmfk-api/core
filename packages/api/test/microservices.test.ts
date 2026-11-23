import { test } from "node:test";
import assert from "node:assert/strict";
import { Req } from "../src/signal/Signal";
import { MicroserviceHost } from "../src/apiServer/external/MicroserviceHost";
import { MicroserviceClient, REQ_MICROSERVICE_CALL } from "../src/apiServer/external/MicroserviceClient";
import { InterceptorSignedAuth } from "../src/apiServer/interceptors/InterceptorSignedAuth";
import { Http } from "../src/apiServer/http/Http";
import { Trace } from "../src/apiServer/helper/Trace";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

const hostKeys = InterceptorSignedAuth.generateKeyPair();
const shopKeys = InterceptorSignedAuth.generateKeyPair();
const otherKeys = InterceptorSignedAuth.generateKeyPair();
const evil = InterceptorSignedAuth.generateKeyPair();

let runs = 0;
let seen: any = null;
let seenTrace: string | null = null;
const REQ_PAY = new Req<any, any>(undefined, "REQ_PAY");
REQ_PAY.listener = async d => {
    runs++;
    seen = MicroserviceHost.currentCall();
    seenTrace = Trace.current();
    await new Promise(r => setTimeout(r, 200));
    return { paid: d.amount };
};
const REQ_ADMIN = new Req<any, any>(undefined, "REQ_ADMIN");
REQ_ADMIN.listener = async () => "secret";
const REQ_BOOM = new Req<any, any>(undefined, "REQ_BOOM");
REQ_BOOM.listener = async () => { throw new Error("db password is hunter2"); };

const PORT = 18801;
const H = `http://localhost:${PORT}/api`;
const RECEIVER = H + "/__ms_host_control/receiver";

const ready = startApi(PORT, [
    new MicroserviceHost({
        id: "crm", requests: [REQ_PAY, REQ_ADMIN, REQ_BOOM], privateKey: hostKeys.privateKey,
        clients: { shop: { publicKey: shopKeys.publicKey, requests: ["REQ_PAY", "REQ_BOOM"] }, other: { publicKey: otherKeys.publicKey } },
    }),
    new MicroserviceClient({ id: "crm", host: H, kid: "shop", privateKey: shopKeys.privateKey, hostPublicKey: hostKeys.publicKey }),
]);

const call = (requestName: string, requestData: any, op?: string) =>
    REQ_MICROSERVICE_CALL.request({ id: "crm", requestName, requestData, op });

const sendSigned = (body: any, kid: string, privateKey: string) => {
    const authorization = InterceptorSignedAuth.sign({ privateKey, kid, method: "POST", url: RECEIVER, data: body });
    return Http.post(RECEIVER, body, { headers: { "x-microservice-id": "crm", authorization } });
};

test("a signed call runs and the handler sees caller and op", async () => {
    await ready;
    const r = await call("REQ_PAY", { amount: 5 }, "pay-000001");
    assert.deepEqual(r, { paid: 5 });
    assert.deepEqual(seen, { caller: "shop", op: "pay-000001", requestName: "REQ_PAY" });
});

test("a repeated op is answered from the store, not run again", async () => {
    await ready;
    const before = runs;
    assert.deepEqual(await call("REQ_PAY", { amount: 5 }, "pay-000001"), { paid: 5 });
    assert.equal(runs, before);
});

test("two concurrent calls with one op run the handler once", async () => {
    await ready;
    const before = runs;
    const [a, b] = await Promise.all([call("REQ_PAY", { amount: 7 }, "pay-000002"), call("REQ_PAY", { amount: 7 }, "pay-000002")]);
    assert.deepEqual(a, { paid: 7 });
    assert.deepEqual(b, { paid: 7 });
    assert.equal(runs, before + 1);
});

test("an op reused for another request is a CONFLICT", async () => {
    await ready;
    const r = await call("REQ_PAY", { amount: 999 }, "pay-000001");
    assert.equal(r.code, 22);
});

test("a request outside the caller's list is FORBIDDEN", async () => {
    await ready;
    assert.equal((await call("REQ_ADMIN", {})).code, 12);
});

test("a crash returns a bare INTERNAL_ERROR, no details or stack", async () => {
    await ready;
    const r = await call("REQ_BOOM", {});
    assert.equal(r.code, 27);
    assert.equal(r.details, undefined);
    assert.equal(r.stack, undefined);
});

test("a wrong key for the kid gets 401", async () => {
    await ready;
    const resp = await sendSigned({ v: 1, to: "crm", op: "evil-00001", requestName: "REQ_PAY", requestData: { amount: 1 } }, "shop", evil.privateKey);
    assert.equal(resp.status, 401);
});

test("another caller with the same op gets its own job, not the first caller's result", async () => {
    await ready;
    const before = runs;
    const resp = await sendSigned({ v: 1, to: "crm", op: "pay-000001", requestName: "REQ_PAY", requestData: { amount: 5 } }, "other", otherKeys.privateKey);
    assert.equal(resp.ok, true);
    assert.equal(runs, before + 1);
});

test("a body changed after signing gets 401", async () => {
    await ready;
    const body = { v: 1, to: "crm", op: "tamper-001", requestName: "REQ_PAY", requestData: { amount: 1 } };
    const authorization = InterceptorSignedAuth.sign({ privateKey: shopKeys.privateKey, kid: "shop", method: "POST", url: RECEIVER, data: body });
    const resp = await Http.post(RECEIVER, { ...body, requestData: { amount: 1000 } }, { headers: { "x-microservice-id": "crm", authorization } });
    assert.equal(resp.status, 401);
});

test("a replayed signed request gets 401", async () => {
    await ready;
    const body = { v: 1, to: "crm", op: "replay-001", requestName: "REQ_PAY", requestData: { amount: 1 } };
    const authorization = InterceptorSignedAuth.sign({ privateKey: shopKeys.privateKey, kid: "shop", method: "POST", url: RECEIVER, data: body });
    await Http.post(RECEIVER, body, { headers: { "x-microservice-id": "crm", authorization } });
    const again = await Http.post(RECEIVER, body, { headers: { "x-microservice-id": "crm", authorization } });
    assert.equal(again.status, 401);
});

test("a request addressed to another host is refused", async () => {
    await ready;
    const resp = await sendSigned({ v: 1, to: "ledger", op: "wrong-host-1", requestName: "REQ_PAY", requestData: {} }, "shop", shopKeys.privateKey);
    assert.equal(resp.ok, false);
});

test("an answer not signed by the expected host is rejected", async () => {
    await ready;
    const liar = new MicroserviceClient({ id: "crm", host: H, kid: "shop", privateKey: shopKeys.privateKey, hostPublicKey: evil.publicKey });
    const r = await liar.requestMicroserviceCall({ id: "crm", requestName: "REQ_PAY", requestData: { amount: 3 } });
    assert.equal(r.code, 19);
    assert.match(r.details, /signature/);
});

test("the host continues the caller's trace id", async () => {
    await ready;
    await Trace.run("trace-from-the-shop-0001", () => call("REQ_PAY", { amount: 1 }, "trace-op-01"));
    assert.equal(seenTrace, "trace-from-the-shop-0001");
});

test("a signed client refuses plain http except to localhost", () => {
    assert.throws(() => new MicroserviceClient({ id: "x", host: "http://10.0.0.5", kid: "shop", privateKey: shopKeys.privateKey, hostPublicKey: hostKeys.publicKey }));
    assert.doesNotThrow(() => new MicroserviceClient({ id: "y", host: "http://127.0.0.1:1", kid: "shop", privateKey: shopKeys.privateKey, hostPublicKey: hostKeys.publicKey }));
});

test("a half-configured signed client is refused", () => {
    assert.throws(() => new MicroserviceClient({ id: "x", host: "https://a", kid: "shop", privateKey: shopKeys.privateKey } as any));
});

test("a host with clients but no private key is refused", () => {
    assert.throws(() => new MicroserviceHost({ id: "z", requests: [], clients: { a: { publicKey: shopKeys.publicKey } } } as any));
});

test("an old shared-key (v1) call is refused, nothing runs", async () => {
    await ready;
    const before = runs;
    const resp = await Http.post(RECEIVER, { tag: "AAAA", enc: "AAAA" }, {
        headers: { "x-microservice-id": "crm", "x-microservice-ts": String(Date.now()), "x-microservice-nonce": "abc" },
    });
    assert.equal(resp.status, 401);
    assert.equal(runs, before);
});

test("a host or client without keys is refused at startup", () => {
    assert.throws(() => new MicroserviceHost({ id: "y", requests: [], privateKey: hostKeys.privateKey } as any), /clients/);
    assert.throws(() => new MicroserviceClient({ id: "y", host: "https://a" } as any), /kid/);
});
