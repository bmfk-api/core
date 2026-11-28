import "./helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Ps, IPsDeps, parseShow, resolveTargets, parseLogArgs, journalArgs, formatJournalLine, buildRows, stateText } from "../src/apiServer/deployment/Ps";
import { renderUnit, listUnits, IUnitSpec } from "../src/apiServer/deployment/SystemdUnit";

const spec = (id: number, name: string, project: string, slot: "blue" | "green" | null, port: string | null): IUnitSpec => ({
    id, name, project, slot, port, workingDirectory: `/var/node/${name}`, node: "/usr/bin/node", entry: `/var/node/${name}/index.js`,
    sourceMaps: false, dataDir: `/home/deploy/.bmfk/${project}`, settings: {},
});

function unitDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-units-"));
    for (const s of [spec(1, "shop-blue", "shop", "blue", "8081"), spec(2, "shop-green", "shop", "green", "8082"), spec(3, "ledger", "ledger", null, "8090")])
        fs.writeFileSync(path.join(dir, `bmfk-${s.name}.service`), renderUnit(s).text!);
    return dir;
}

const SHOW = [
    "Id=bmfk-shop-blue.service\nActiveState=active\nSubState=running\nMainPID=4123\nNRestarts=0\nMemoryCurrent=190840832\nCPUUsageNSec=1000000000\nActiveEnterTimestampMonotonic=1000000000\nUnitFileState=enabled\nResult=success\nExecMainStatus=0",
    "Id=bmfk-shop-green.service\nActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\nMemoryCurrent=[not set]\nCPUUsageNSec=[not set]\nActiveEnterTimestampMonotonic=0\nUnitFileState=disabled\nResult=success\nExecMainStatus=0",
    "Id=bmfk-ledger.service\nActiveState=failed\nSubState=failed\nMainPID=0\nNRestarts=10\nMemoryCurrent=18446744073709551615\nCPUUsageNSec=18446744073709551615\nActiveEnterTimestampMonotonic=0\nUnitFileState=enabled\nResult=start-limit-hit\nExecMainStatus=1",
].join("\n\n");

test("ps: systemctl show blocks → state per unit; UINT64_MAX and [not set] are unknown", () => {
    const st = parseShow(SHOW);
    assert.equal(st.size, 3);
    assert.deepEqual(stateText(st.get("bmfk-shop-blue.service")), { text: "online", bad: false });
    assert.deepEqual(stateText(st.get("bmfk-shop-green.service")), { text: "stopped", bad: false });
    assert.deepEqual(stateText(st.get("bmfk-ledger.service")), { text: "failed (loop)", bad: true });
    assert.equal(st.get("bmfk-ledger.service")!.memory, null);
    assert.equal(st.get("bmfk-shop-green.service")!.enabled, false);

    const rows = buildRows(listUnits(unitDir()), st, 1000 + 3 * 3600, new Map([["bmfk-shop-blue.service", 0.4]]));
    assert.deepEqual(rows.map(r => [r.id, r.name, r.slot, r.state, r.pid, r.uptime, r.mem, r.cpu, r.port, r.boot]), [
        ["1", "shop", "blue", "online", "4123", "3h 0m", "182 MB", "0.4%", "8081", "✓"],
        ["2", "shop", "green", "stopped", "—", "—", "—", "—", "8082", "—"],
        ["3", "ledger", "—", "failed (loop)", "—", "—", "—", "—", "8090", "✓"],
    ]);
});

test("ps: an id, a process, a project (both slots) or all — nothing else reaches systemctl", () => {
    const units = listUnits(unitDir());
    assert.deepEqual(resolveTargets("1", units, false).map(u => u.name), ["shop-blue"]);
    assert.deepEqual(resolveTargets("shop-green", units, false).map(u => u.name), ["shop-green"]);
    assert.deepEqual(resolveTargets("shop", units, false).map(u => u.name), ["shop-blue", "shop-green"]);
    assert.deepEqual(resolveTargets("all", units, true).length, 3);
    assert.deepEqual(resolveTargets("all", units, false), []);
    assert.deepEqual(resolveTargets("sshd", units, true), []);
    assert.deepEqual(resolveTargets("--user", units, true), []);
});

test("ps log: options, and the journalctl call they make", () => {
    assert.ok(parseLogArgs([]).error);
    assert.ok(parseLogArgs(["1", "2"]).error);
    assert.ok(parseLogArgs(["1", "--since", "--output=cat"]).error);
    assert.ok(parseLogArgs(["1", "-n", "abc"]).error);
    const p = parseLogArgs(["shop", "-f", "-n", "50", "--errors", "--since", "2h"]);
    assert.deepEqual(p, { target: "shop", opts: { follow: true, lines: 50, errors: true, since: "-2h" } });
    const units = listUnits(unitDir()).slice(0, 1);
    assert.deepEqual(journalArgs(units, p.opts!),
        ["-o", "json", "--no-pager", "-n", "50", "--user-unit=bmfk-shop-blue.service", "-p", "warning", "--since=-2h", "-f"]);
    assert.deepEqual(journalArgs("all", { follow: false, lines: 100, errors: false, since: null }),
        ["-o", "json", "--no-pager", "-n", "100", "--user-unit=bmfk-*"]);
});

test("ps log: journal JSON → time, process, message (bytes too)", () => {
    const plain = { red: (t: string) => `R(${t})`, yellow: (t: string) => `Y(${t})`, green: (t: string) => t, blue: (t: string) => t, dim: (t: string) => t, bold: (t: string) => t };
    const line = formatJournalLine(JSON.stringify({ __REALTIME_TIMESTAMP: "1795000000000000", MESSAGE: "listening on 8081", PRIORITY: "6", _SYSTEMD_USER_UNIT: "bmfk-shop-blue.service" }), true, plain)!;
    assert.match(line, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d shop-blue\s+ listening on 8081$/);
    const err = formatJournalLine(JSON.stringify({ MESSAGE: [104, 105], PRIORITY: "3", _SYSTEMD_USER_UNIT: "bmfk-ledger.service" }), false, plain)!;
    assert.ok(err.endsWith("R(hi)"), err);
    assert.equal(formatJournalLine("not json", false, plain), null);
});

function deps(over: Partial<IPsDeps> = {}): { d: IPsDeps; out: string[]; err: string[]; calls: string[][] } {
    const out: string[] = [], err: string[] = [], calls: string[][] = [];
    const d: IPsDeps = {
        systemctl: async (a) => { calls.push(a); return a[0] === "show" ? SHOW : ""; },
        unitDir: unitDir(), platform: "linux",
        out: (s) => out.push(s), err: (s) => err.push(s),
        pm2: async () => null,
        journal: async () => 0,
        user: "deploy", exists: () => true, read: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } },
        ask: async () => { throw new Error("no control channel"); },
        ...over,
    };
    return { d, out, err, calls };
}

test("ps stop/start/restart: stop also disables (no start at boot), start enables", async () => {
    let t = deps();
    assert.equal(await Ps(["stop", "shop"], t.d), 0);
    assert.deepEqual(t.calls, [["stop", "bmfk-shop-blue.service"], ["disable", "bmfk-shop-blue.service"], ["stop", "bmfk-shop-green.service"], ["disable", "bmfk-shop-green.service"]]);
    t = deps();
    assert.equal(await Ps(["start", "3"], t.d), 0);
    assert.deepEqual(t.calls, [["reset-failed", "bmfk-ledger.service"], ["enable", "bmfk-ledger.service"], ["start", "bmfk-ledger.service"]]);
    t = deps();
    assert.equal(await Ps(["restart", "nginx"], t.d), 1);
    assert.deepEqual(t.calls, []);
    t = deps({ platform: "darwin" });
    assert.equal(await Ps(["restart", "all"], t.d), 1);
});

test("ps startup: names what's missing and prints the fix, never runs it", async () => {
    const t = deps({ exists: (p) => !p.includes("linger"), read: (p) => p.endsWith("journald.conf") ? "[Journal]\nStorage=volatile\n" : p === "/proc/sys/user/max_user_namespaces" ? "0\n" : null });
    assert.equal(await Ps(["startup"], t.d), 1);
    const text = t.out.join("\n");
    assert.match(text, /sudo loginctl enable-linger deploy/);
    assert.match(text, /Storage=persistent/);
    assert.match(text, /unprivileged_userns_clone=1/);
    assert.ok(t.calls.every(c => c[0] === "is-system-running" || c[0] === "show"));
});

import { cpuPercent } from "../src/apiServer/deployment/Ps";
import { UnitWatch, QUIET_MS } from "../src/apiServer/deployment/UnitWatch";

const st = (over: Record<string, unknown>) => ({
    activeState: "active", subState: "running", pid: 10, restarts: 0, memory: 1, memoryPeak: null, tasks: null, ioRead: null, ioWrite: null,
    cpuNs: 0, activeSinceUs: 1, enabled: true, result: "success", exitStatus: "0", ...over,
}) as any;

test("ps: cpu between two readings, as % of one core; a restarted process has none", () => {
    const a = new Map([["x", st({ cpuNs: 0 })], ["y", st({ cpuNs: 0, pid: 1 })]]);
    const b = new Map([["x", st({ cpuNs: 250_000_000 })], ["y", st({ cpuNs: 9e9, pid: 2 })]]);
    const cpu = cpuPercent(a, b, 1000);
    assert.equal(cpu.get("x"), 25);
    assert.equal(cpu.has("y"), false);
});

test("watch: crash → one alert per 5 minutes with the count; crash loop and recovery; a stop is not an alert", () => {
    const w = new UnitWatch();
    const t0 = 1_000_000;
    assert.deepEqual(w.next(new Map([["a", st({})], ["b", st({ activeState: "failed", subState: "failed", result: "exit-code" })]]), t0).map(e => [e.unit, e.kind]),
        [["b", "failed"]]);                                       // failed at startup: said once
    assert.deepEqual(w.next(new Map([["a", st({ restarts: 1, pid: 11 })], ["b", st({ activeState: "failed", subState: "failed" })]]), t0 + 10_000).map(e => [e.unit, e.kind]),
        [["a", "crashed"]]);
    assert.deepEqual(w.next(new Map([["a", st({ restarts: 3, pid: 13 })], ["b", st({ activeState: "failed", subState: "failed" })]]), t0 + 20_000), []);
    const later = w.next(new Map([["a", st({ restarts: 4, pid: 14 })], ["b", st({})]]), t0 + 10_000 + QUIET_MS);
    assert.deepEqual(later.map(e => [e.unit, e.kind]), [["a", "crashed"], ["b", "recovered"]]);
    assert.match(later[0].text, /3 times/);
    const loop = w.next(new Map([["a", st({ activeState: "failed", subState: "failed", result: "start-limit-hit", restarts: 10 })], ["b", st({ activeState: "inactive", subState: "dead" })]]), t0 + 2 * QUIET_MS);
    assert.deepEqual(loop.map(e => [e.unit, e.kind]), [["a", "failed"]]);
    assert.match(loop[0].text, /crash loop/);
    // A manual restart resets NRestarts: no alert.
    assert.deepEqual(w.next(new Map([["a", st({ restarts: 0 })], ["b", st({ activeState: "inactive", subState: "dead" })]]), t0 + 3 * QUIET_MS).map(e => e.kind), ["recovered"]);
});

test("ps loglevel: through the app's control socket; a unit without one is named", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-units-"));
    fs.writeFileSync(path.join(dir, "bmfk-shop-blue.service"), renderUnit({ ...spec(1, "shop-blue", "shop", "blue", "8081"), control: "/home/deploy/.bmfk/shop/control-blue.sock" }).text!);
    fs.writeFileSync(path.join(dir, "bmfk-ledger.service"), renderUnit(spec(2, "ledger", "ledger", null, null)).text!);
    const asked: unknown[][] = [];
    const t = deps({ unitDir: dir, ask: (async (sock: string, op: string, args?: unknown) => { asked.push([sock, op, args]); return { level: "debug", before: "all" }; }) as any });
    assert.equal(await Ps(["loglevel", "all", "warn"], t.d), 1);   // ledger has no channel
    assert.deepEqual(asked, [["/home/deploy/.bmfk/shop/control-blue.sock", "loglevel", { level: "warn" }]]);
    assert.match(t.err.join("\n"), /ledger: no control channel/);
    assert.equal(await Ps(["loglevel", "1", "verbose"], deps({ unitDir: dir }).d), 1);
});

test("ps: metrics from inside the app; 5xx, a stalled loop or a full heap are flagged", async () => {
    const { metricsCells } = await import("../src/apiServer/deployment/Ps");
    assert.deepEqual(metricsCells(undefined), { rpm: "—", epm: "—", lag: "—", heap: "—", hot: false });
    const m = { requestsPerMin: 120, errorsPerMin: 0, inFlight: 1, connections: 3, loopDelayP99Ms: 12.4, loopDelayMeanMs: 10, loopUtilizationPct: 5, heapUsed: 50 * 1024 * 1024, heapLimit: 2 * 1024 ** 3, rss: 1 };
    assert.deepEqual(metricsCells(m), { rpm: "120", epm: "0", lag: "12ms", heap: "50 MB", hot: false });
    assert.equal(metricsCells({ ...m, errorsPerMin: 3 }).hot, true);
    assert.equal(metricsCells({ ...m, loopDelayP99Ms: 450 }).hot, true);
    assert.match(metricsCells({ ...m, heapUsed: 1.8 * 1024 ** 3 }).heap, /\(90%\)/);
});
