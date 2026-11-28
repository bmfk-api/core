import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApi, exitWhenDone, waitFor } from "./helpers";
import { APIService } from "../src/apiServer/APIService";
import { controlCall, controlSocketPath, CONTROL_SOCKET_ENV, ControlError } from "../src/apiServer/control/Control";
import { runReadinessChecks, addReadinessCheck } from "../src/apiServer/control/ReadinessChecks";

exitWhenDone();

const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctl-")), "control.sock");
fs.writeFileSync(sock, "");   // a stale leftover that isn't a socket: the channel must refuse it, not delete it
fs.unlinkSync(sock);
process.env[CONTROL_SOCKET_ENV] = sock;

let dbUp = true;
APIService.addReadinessCheck("db", () => dbUp || "connection refused");
const started = startApi(18431);

test("control: the socket is 0600 and answers ping, metrics, ready, loglevel", async () => {
    const api = await started;
    await waitFor(() => fs.existsSync(sock));
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);

    const ping = await controlCall<any>(sock, "ping");
    assert.equal(ping.pid, process.pid);
    assert.equal(typeof ping.version, "string");

    // Probes (liveness, readiness) are not counted; anything else is.
    await fetch(`${api.url}/no-such-endpoint`);
    const m = await controlCall<any>(sock, "metrics");
    assert.ok(m.requestsPerMin >= 1, JSON.stringify(m));
    assert.equal(m.errorsPerMin, 0);
    assert.ok(m.heapUsed > 0 && m.heapLimit > m.heapUsed);

    assert.deepEqual((await controlCall<any>(sock, "ready")).ready, true);
    dbUp = false;
    const r = await controlCall<any>(sock, "ready");
    assert.equal(r.ready, false);
    assert.deepEqual(r.checks.map((c: any) => [c.name, c.ok, c.detail]), [["db", false, "connection refused"]]);
    // Public /readiness: 503, no reason.
    const http = await fetch(`${api.url}/readiness`);
    assert.equal(http.status, 503);
    assert.ok(!(await http.text()).includes("connection refused"));
    dbUp = true;
    assert.equal((await fetch(`${api.url}/readiness`)).status, 200);

    const lv = await controlCall<any>(sock, "loglevel", { level: "warn" });
    assert.equal(lv.level, "warn");
    assert.equal((await controlCall<any>(sock, "loglevel")).level, "warn");
    await controlCall(sock, "loglevel", { level: "all" });
    await assert.rejects(controlCall(sock, "loglevel", { level: "verbose" }), (e: ControlError) => e.code === "refused");
});

test("control: unknown operations and other protocols are refused", async () => {
    await started;
    await assert.rejects(controlCall(sock, "exec" as any), (e: ControlError) => e.code === "refused" && /unknown operation/.test(e.message));
    const raw = await new Promise<string>((resolve) => {
        const c = require("net").createConnection(sock, () => c.write(JSON.stringify({ v: 2, id: 1, op: "ping" }) + "\n"));
        c.on("data", (d: Buffer) => { resolve(d.toString()); c.destroy(); });
    });
    assert.match(raw, /protocol 1 only/);
    await assert.rejects(controlCall(path.join(path.dirname(sock), "nobody.sock"), "ping"), (e: ControlError) => e.code === "unreachable");
});

test("readiness checks: false, a reason, a throw and a hang are all not ready", async () => {
    const off = [
        addReadinessCheck("t-false", () => false),
        addReadinessCheck("t-throw", () => { throw new Error("boom"); }),
        addReadinessCheck("t-hang", () => new Promise(() => { })),
    ];
    try {
        const r = await runReadinessChecks(100);
        const by = Object.fromEntries(r.checks.map(c => [c.name, c]));
        assert.equal(r.ready, false);
        assert.equal(by["t-false"].detail, "not ready");
        assert.equal(by["t-throw"].detail, "boom");
        assert.match(by["t-hang"].detail!, /no answer/);
        assert.throws(() => addReadinessCheck("t-false", () => true), /already/);
        assert.throws(() => addReadinessCheck("bad name", () => true), /letters/);
    } finally { off.forEach(f => f()); }
});

test("control socket path: in the project's data folder, per slot; too long → none", () => {
    assert.equal(controlSocketPath("shop", "blue"), path.join(process.env.BMFK_DATA_DIR!, "shop", "control-blue.sock"));
    // sun_path is ~100 bytes: a long data root gives no socket (the app runs without the channel).
    const saved = process.env.BMFK_DATA_DIR;
    process.env.BMFK_DATA_DIR = "/" + "d".repeat(90);
    try { assert.equal(controlSocketPath("shop", "green"), null); }
    finally { process.env.BMFK_DATA_DIR = saved; }
});

test("SIGTERM: a request in progress finishes, then the process exits 0", async () => {
    const app = path.join(__dirname, "fixtures", "slow-app.js");
    const env = { ...process.env };
    delete env[CONTROL_SOCKET_ENV];
    const child = spawn(process.execPath, [app, "18432"], { env, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((res) => child.stdout.on("data", (d: Buffer) => { if (d.toString().includes("ready")) res(); }));
    const exited = new Promise<number | null>(res => child.on("exit", code => res(code)));

    const slow = fetch("http://localhost:18432/api/slow").then(async r => [r.status, await r.json()] as const);
    await new Promise(r => setTimeout(r, 200));
    child.kill("SIGTERM");
    const [status, body] = await slow;
    assert.equal(status, 200);
    assert.equal((body as any).data, "done");
    assert.equal(await exited, 0);
});

test("SIGTERM: past shutdownTimeoutMs the request is cut and the process still exits", async () => {
    const app = path.join(__dirname, "fixtures", "slow-app.js");
    const env = { ...process.env };
    delete env[CONTROL_SOCKET_ENV];
    const child = spawn(process.execPath, [app, "18433", "100"], { env, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((res) => child.stdout.on("data", (d: Buffer) => { if (d.toString().includes("ready")) res(); }));
    const exited = new Promise<number | null>(res => child.on("exit", code => res(code)));
    const slow = fetch("http://localhost:18433/api/slow").then(() => "answered", () => "cut");
    await new Promise(r => setTimeout(r, 100));
    const t = Date.now();
    child.kill("SIGTERM");
    assert.equal(await slow, "cut");
    assert.equal(await exited, 0);
    assert.ok(Date.now() - t < 700, `took ${Date.now() - t} ms`);
});
