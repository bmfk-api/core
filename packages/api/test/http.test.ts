import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Http } from "../src/apiServer/http/Http";

// A server that always answers 503 and counts the hits.
let hits = 0;
const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => { res.statusCode = 503; res.end("{}"); });
});
const ready = new Promise<void>(r => server.listen(18802, r));
after(() => server.close());
const URL_ = "http://localhost:18802/charge";

test("by default a failed POST is not retried", async () => {
    await ready;
    hits = 0;
    const r = await Http.post(URL_, { amount: 100 });
    assert.equal(r.ok, false);
    assert.equal(hits, 1);
});

test("by default a failed GET is not retried either", async () => {
    await ready;
    hits = 0;
    await Http.get(URL_);
    assert.equal(hits, 1);
});

test("retry: { enabled: true } retries once on 503", async () => {
    await ready;
    hits = 0;
    await Http.get(URL_, { retry: { enabled: true, baseDelayMs: 1, maxDelayMs: 1 } });
    assert.equal(hits, 2);
});

test("multipart is never retried, whatever the options say", async () => {
    await ready;
    hits = 0;
    const fd = new FormData();
    fd.set("a", "1");
    await Http.post(URL_, fd, { retry: { enabled: true, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    assert.equal(hits, 1);
});
