import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { APIService } from "../src/apiServer/APIService";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

const PORT = 18807;
const ready = startApi(PORT, [], { corsHostWhiteList: ["app.example.com"] });

function get(headers: Record<string, string>): Promise<{ status: number, headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/liveness", headers }, res => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("originVerdict: same-origin, listed, wildcard, denied", () => {
    const listed = new Set(["https://app.example.com"]);
    assert.equal(APIService.originVerdict("https://api.example.com", "api.example.com", listed, false), "same");
    assert.equal(APIService.originVerdict("https://app.example.com", "api.example.com", listed, false), "listed");
    assert.equal(APIService.originVerdict("https://evil.example", "api.example.com", listed, true), "any");
    assert.equal(APIService.originVerdict("https://evil.example", "api.example.com", listed, false), "denied");
    assert.equal(APIService.originVerdict("not a url", "api.example.com", listed, true), "denied");
});

test("a foreign site is refused; the API's own page and listed origins pass with credentials", async () => {
    await ready;
    const evil = await get({ Origin: "https://evil.example", Host: "api.example.com" });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);

    const own = await get({ Origin: "https://api.example.com", Host: "api.example.com" });
    assert.equal(own.status, 200);

    const listed = await get({ Origin: "https://app.example.com", Host: "api.example.com" });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers["access-control-allow-origin"], "https://app.example.com");
    assert.equal(listed.headers["access-control-allow-credentials"], "true");

    const server = await get({ Host: "api.example.com" });            // no Origin: not a browser
    assert.equal(server.status, 200);
});

test("localhost:3000 is no longer allowed by default", async () => {
    await ready;
    assert.equal((await get({ Origin: "http://localhost:3000", Host: "api.example.com" })).status, 403);
});
