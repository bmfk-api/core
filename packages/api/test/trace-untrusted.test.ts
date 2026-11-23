import { test } from "node:test";
import assert from "node:assert/strict";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

// No trusted proxies: the client talks to the service directly, so its header is not believed.
const api = startApi(18804, [], { trustedProxies: [] });

test("X-Request-Id from an untrusted client is ignored", async () => {
    await api;
    const res = await fetch("http://localhost:18804/api/liveness", { headers: { "x-request-id": "planted-by-client-0001" } });
    assert.notEqual(res.headers.get("x-request-id"), "planted-by-client-0001");
});
