import { test } from "node:test";
import assert from "node:assert/strict";
import { APIService, getDefaultOptions } from "../src/apiServer/APIService";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

const PORT = 18808;
const ready = startApi(PORT, [], { corsHostWhiteList: ["*"] });

test('"*" lets any site in, but without credentials', async () => {
    await ready;
    const r = await fetch(`http://localhost:${PORT}/api/liveness`, { headers: { Origin: "https://anyone.example" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("access-control-allow-credentials"), null);
});

test("a WebSocket server needs onAuthorize, or public: true said on purpose", async () => {
    const api = new APIService(getDefaultOptions({ port: 18809, websocketServer: {}, blockedIps: false, threatMonitoring: false, metricsDir: false }));
    await assert.rejects(api.init(), /onAuthorize, or public: true/);
});

test("uploads go to a private folder in the data folder, not /tmp", () => {
    const api = new APIService(getDefaultOptions({ port: 18810 })) as any;
    const dir: string = api.uploadDir();
    assert.ok(dir.startsWith(process.env.BMFK_DATA_DIR!), dir);
    assert.ok(dir.endsWith("uploads"));
});
