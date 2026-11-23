import { test } from "node:test";
import assert from "node:assert/strict";
import { Req } from "../src/signal/Signal";
import { MicroserviceHost } from "../src/apiServer/external/MicroserviceHost";
import { MicroserviceClient, REQ_MICROSERVICE_CALL } from "../src/apiServer/external/MicroserviceClient";
import { InterceptorSignedAuth } from "../src/apiServer/interceptors/InterceptorSignedAuth";
import { Http } from "../src/apiServer/http/Http";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

const hostKeys = InterceptorSignedAuth.generateKeyPair();
const local = InterceptorSignedAuth.generateKeyPair();
const far = InterceptorSignedAuth.generateKeyPair();
const proxied = InterceptorSignedAuth.generateKeyPair();

let runs = 0;
const REQ_PING = new Req<any, any>(undefined, "REQ_IP_PING");
REQ_PING.listener = async () => { runs++; return "pong"; };

const PORT = 18805;
const H = `http://localhost:${PORT}/api`;
const RECEIVER = H + "/__ms_host_control/receiver";

// Loopback is a trusted proxy by default (nginx on the same host), so X-Real-IP from it is believed.
const ready = startApi(PORT, [
    new MicroserviceHost({
        id: "ipcheck", requests: [REQ_PING], privateKey: hostKeys.privateKey,
        clients: {
            local: { publicKey: local.publicKey, allowedIps: ["127.0.0.1", "::1"] },
            far: { publicKey: far.publicKey, allowedIps: ["203.0.113.0/24"] },
            proxied: { publicKey: proxied.publicKey, allowedIps: ["198.51.100.7"] },
        },
    }),
    new MicroserviceClient({ id: "ipcheck", host: H, kid: "local", privateKey: local.privateKey, hostPublicKey: hostKeys.publicKey }),
]);

const sendSigned = (kid: string, privateKey: string, headers: Record<string, string> = {}) => {
    const body = { v: 1, to: "ipcheck", op: "op-" + Math.random().toString(36).slice(2, 12), requestName: "REQ_IP_PING", requestData: null };
    const authorization = InterceptorSignedAuth.sign({ privateKey, kid, method: "POST", url: RECEIVER, data: body });
    return Http.post(RECEIVER, body, { headers: { "x-microservice-id": "ipcheck", authorization, ...headers } });
};

test("a caller from an allowed address gets through", async () => {
    await ready;
    assert.equal(await REQ_MICROSERVICE_CALL.request({ id: "ipcheck", requestName: "REQ_IP_PING", requestData: null }), "pong");
});

test("a valid key from an address outside its allowedIps gets 403, and nothing runs", async () => {
    await ready;
    const before = runs;
    const r = await sendSigned("far", far.privateKey);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(runs, before);
});

test("the address nginx passes in X-Real-IP is the one checked", async () => {
    await ready;
    const ok = await sendSigned("proxied", proxied.privateKey, { "x-real-ip": "198.51.100.7" });
    assert.equal(ok.ok, true);
    const no = await sendSigned("proxied", proxied.privateKey, { "x-real-ip": "198.51.100.8" });
    assert.equal(no.status, 403);
});

test("a broken or empty allowedIps stops the host", () => {
    const mk = (allowedIps: string[]) => () => new MicroserviceHost({
        id: "broken", requests: [], privateKey: hostKeys.privateKey, clients: { x: { publicKey: local.publicKey, allowedIps } },
    });
    assert.throws(mk(["10.0.0.300"]), /allowedIps/);
    assert.throws(mk(["10.0.0.0/33"]), /allowedIps/);
    assert.throws(mk([]), /empty/);
});
