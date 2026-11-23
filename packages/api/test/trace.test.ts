import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseEndpoint } from "../src/apiServer/BaseEndpoint";
import { IRequest, IResponse } from "../src/apiServer/structures/Interfaces";
import { logInfo } from "../src/apiServer/LogService";
import { Trace } from "../src/apiServer/helper/Trace";
import { startApi, exitWhenDone, waitFor } from "./helpers";

exitWhenDone();

let handlerSaw: { trace: string | null, reqTrace?: string } | null = null;

class Echo extends BaseEndpoint {
    constructor() {
        super("echo");
        this.registerEndpoints([{ endpoint: "run", handler: this.run, ignoreInterceptor: true }]);
    }
    async run(req: IRequest): Promise<IResponse> {
        await new Promise(r => setTimeout(r, 10));        // across an await
        handlerSaw = { trace: Trace.current(), reqTrace: req.traceId };
        logInfo("handled echo " + req.data.n);
        return { data: { ok: true } };
    }
}

const trusted = startApi(18803, [], { endpoints: [new Echo()] });

test("every response has an X-Request-Id and the same traceId in the body", async () => {
    await trusted;
    const res = await fetch("http://localhost:18803/api/echo/run?n=1");
    const body: any = await res.json();
    const id = res.headers.get("x-request-id");
    assert.ok(Trace.isValid(id));
    assert.equal(body.traceId, id);
});

test("the handler, the request object and log lines carry the request's id", async () => {
    const api = await trusted;
    const res = await fetch("http://localhost:18803/api/echo/run?n=2");
    const id = res.headers.get("x-request-id")!;
    assert.deepEqual(handlerSaw, { trace: id, reqTrace: id });
    await waitFor(() => api.logs.some(l => l.text.includes("handled echo 2")));
    assert.equal(api.logs.find(l => l.text.includes("handled echo 2"))!.traceId, id);
});

test("two requests get different ids", async () => {
    await trusted;
    const a = (await fetch("http://localhost:18803/api/echo/run")).headers.get("x-request-id");
    const b = (await fetch("http://localhost:18803/api/echo/run")).headers.get("x-request-id");
    assert.notEqual(a, b);
});

test("an unknown route still gets an id", async () => {
    await trusted;
    const res = await fetch("http://localhost:18803/api/nope");
    assert.ok(Trace.isValid(res.headers.get("x-request-id")));
});

test("X-Request-Id from a trusted proxy (loopback by default) is kept", async () => {
    await trusted;
    const res = await fetch("http://localhost:18803/api/echo/run", { headers: { "x-request-id": "nginx-req-0123456789" } });
    assert.equal(res.headers.get("x-request-id"), "nginx-req-0123456789");
});

test("a malformed X-Request-Id is replaced", async () => {
    await trusted;
    const res = await fetch("http://localhost:18803/api/echo/run", { headers: { "x-request-id": "bad id <script>" } });
    assert.notEqual(res.headers.get("x-request-id"), "bad id <script>");
    assert.ok(Trace.isValid(res.headers.get("x-request-id")));
});
