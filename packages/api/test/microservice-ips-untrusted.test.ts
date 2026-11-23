import { test } from "node:test";
import assert from "node:assert/strict";
import { Req } from "../src/signal/Signal";
import { MicroserviceHost } from "../src/apiServer/external/MicroserviceHost";
import { InterceptorSignedAuth } from "../src/apiServer/interceptors/InterceptorSignedAuth";
import { Http } from "../src/apiServer/http/Http";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

const hostKeys = InterceptorSignedAuth.generateKeyPair();
const caller = InterceptorSignedAuth.generateKeyPair();
const REQ_PING = new Req<any, any>(undefined, "REQ_IP_PING2");
REQ_PING.listener = async () => "pong";

const PORT = 18806;
const RECEIVER = `http://localhost:${PORT}/api/__ms_host_control/receiver`;

// No trusted proxies: the caller talks to the service directly, so an X-Real-IP it sends is just text.
const ready = startApi(PORT, [
    new MicroserviceHost({
        id: "ipcheck2", requests: [REQ_PING], privateKey: hostKeys.privateKey,
        clients: { c: { publicKey: caller.publicKey, allowedIps: ["198.51.100.7"] } },
    }),
], { trustedProxies: [] });

test("X-Real-IP from a caller that is not a trusted proxy does not open the list", async () => {
    await ready;
    const body = { v: 1, to: "ipcheck2", op: "op-planted-0001", requestName: "REQ_IP_PING2", requestData: null };
    const authorization = InterceptorSignedAuth.sign({ privateKey: caller.privateKey, kid: "c", method: "POST", url: RECEIVER, data: body });
    const r = await Http.post(RECEIVER, body, { headers: { "x-microservice-id": "ipcheck2", authorization, "x-real-ip": "198.51.100.7" } });
    assert.equal(r.status, 403);
});
