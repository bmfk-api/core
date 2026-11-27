import "./helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runnerKind } from "../src/apiServer/deployment/ProcessRunner";
import { SystemdRunner } from "../src/apiServer/deployment/SystemdRunner";
import { allocateId, listUnits, renderUnit, settingsProblems, IUnitSpec } from "../src/apiServer/deployment/SystemdUnit";
import { AppData } from "../src/apiServer/helper/AppDataPath";

const spec = (over: Partial<IUnitSpec> = {}): IUnitSpec => ({
    id: 3, name: "shop-blue", project: "shop", slot: "blue", port: "8081",
    workingDirectory: "/var/node/shop/blue", node: "/usr/bin/node", entry: "/var/node/shop/blue/bin/Main.js",
    sourceMaps: true, dataDir: "/home/deploy/.bmfk/shop", settings: {}, ...over,
});

test("runner: \"runner\" wins, else pm2 true/false decides (1.0/1.1 configs unchanged)", () => {
    assert.equal(runnerKind({ pm2: true } as any), "pm2");
    assert.equal(runnerKind({ pm2: false } as any), "none");
    assert.equal(runnerKind({ pm2: true, runner: "systemd" } as any), "systemd");
    assert.equal(runnerKind({ pm2: false, runner: "pm2" } as any), "pm2");
    assert.equal(runnerKind({ pm2: true, runner: "none" } as any), "none");
    assert.ok(typeof runnerKind({ pm2: true, runner: "docker" } as any) === "object");
});

test("systemd settings: anything that would need escaping in a unit file is refused", () => {
    assert.deepEqual(settingsProblems(undefined), []);
    assert.deepEqual(settingsProblems({ node_args: ["--max-old-space-size=512"], env: { TZ: "UTC", GREETING: "hello world" }, memory_max: "512M", stop_timeout: 20, sandbox: false }), []);
    const bad = [
        { node_args: ["--require /tmp/x.js"] },        // a space: two tokens in ExecStart
        { node_args: ["-r"] },
        { env: { "A-B": "1" } },
        { env: { A: 'x" Environment="LD_PRELOAD=/tmp/x' } },
        { env: { A: "line\nExecStart=/bin/sh" } },
        { env: { A: "100%" } },                           // systemd specifier
        { env: { BMFK_UNIT: "other" } },
        { memory_max: "1G; rm" },
        { stop_timeout: 0 },
        { memory_high: "2G", memory_max: "1G" },
        { memory_high: "1.5G" },
        { sandbox: "no" },
        { restart: "no" },
    ];
    for (const b of bad) assert.ok(settingsProblems(b).length > 0, JSON.stringify(b));
});

test("unit: ids, sandbox, restart and boot; paths that need quoting are refused", () => {
    assert.deepEqual(settingsProblems({ memory_high: "768M", memory_max: "1G" }), []);
    const { text } = renderUnit(spec({ settings: { env: { TZ: "UTC" }, memory_high: "768M", memory_max: "1G" } }));
    assert.ok(text);
    for (const line of [
        "X-Bmfk-Id=3", "X-Bmfk-Project=shop", "X-Bmfk-Slot=blue", "X-Bmfk-Port=8081",
        "WorkingDirectory=/var/node/shop/blue",
        "ExecStart=/usr/bin/node --enable-source-maps /var/node/shop/blue/bin/Main.js",
        "Environment=BMFK_UNIT=bmfk-shop-blue.service", 'Environment="TZ=UTC"',
        "Restart=always", "MemoryHigh=768M", "MemoryMax=1G", "IOAccounting=yes", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=read-only",
        "ReadWritePaths=-/var/node/shop/blue -/home/deploy/.bmfk/shop",
        "WantedBy=default.target",
    ]) assert.ok(text!.split("\n").includes(line), line);

    const open = renderUnit(spec({ settings: { sandbox: false }, sourceMaps: false })).text!;
    assert.ok(!open.includes("ProtectSystem"));
    assert.ok(open.includes("NoNewPrivileges=yes"));
    assert.ok(open.includes("ExecStart=/usr/bin/node /var/node/shop/blue/bin/Main.js"));

    assert.ok(renderUnit(spec({ workingDirectory: "/var/node/my shop" })).problems);
    assert.ok(renderUnit(spec({ entry: "/var/node/shop/%n.js" })).problems);
    assert.ok(renderUnit(spec({ workingDirectory: "relative/dir" })).problems);
});

test("ids: kept by the unit, new ones take the next number", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "units-"));
    fs.writeFileSync(path.join(dir, "bmfk-shop-blue.service"), renderUnit(spec({ id: 1 })).text!);
    fs.writeFileSync(path.join(dir, "bmfk-ledger.service"), renderUnit(spec({ id: 4, name: "ledger", project: "ledger", slot: null, port: null })).text!);
    fs.writeFileSync(path.join(dir, "other.service"), "[Unit]\nX-Bmfk-Id=99\n");
    const units = listUnits(dir);
    assert.deepEqual(units.map(u => [u.id, u.name, u.slot]), [[1, "shop-blue", "blue"], [4, "ledger", null]]);
    assert.equal(allocateId("shop-blue", units), 1);
    assert.equal(allocateId("shop-green", units), 5);
    assert.equal(allocateId("x", []), 1);
});

function fakeProject() {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    fs.mkdirSync(path.join(dest, "bin"));
    fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({ name: "shop", main: "bin/Main.js" }));
    fs.writeFileSync(path.join(dest, "bin", "Main.js"), "");
    return dest;
}

test("SystemdRunner: writes the unit, enables it for boot, restarts it", async () => {
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "units-"));
    const dest = fakeProject();
    const calls: string[][] = [];
    const runner = new SystemdRunner({ unitDir, node: "/usr/bin/node", settleMs: 0, platform: "linux",
        systemctl: async (args) => { calls.push(args); return ""; } });
    const err = await runner.start({ name: "shop", systemd: { memory_max: "256M" } } as any,
        { name: "shop", project: "shop", slot: null, destination: dest, config: { PORT: 8090 } });
    assert.equal(err, null);
    assert.deepEqual(calls, [["daemon-reload"], ["enable", "bmfk-shop.service"], ["reset-failed", "bmfk-shop.service"], ["restart", "bmfk-shop.service"]]);
    const text = fs.readFileSync(path.join(unitDir, "bmfk-shop.service"), "utf-8");
    assert.ok(text.includes(`ExecStart=/usr/bin/node ${dest}/bin/Main.js`));
    assert.ok(text.includes("X-Bmfk-Port=8090"));
    assert.ok(text.includes("MemoryMax=256M"));
    assert.ok(fs.statSync(AppData.projectDir("shop")).isDirectory());
});

test("SystemdRunner: a process that crashes right after the restart fails the deploy", async () => {
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "units-"));
    let pid = 100;
    const runner = new SystemdRunner({ unitDir, node: "/usr/bin/node", settleMs: 5, platform: "linux",
        systemctl: async (args) => args[0] === "show" ? `ActiveState=active\nSubState=running\nMainPID=${pid++}\n` : "" });
    const err = await runner.start({ name: "shop" } as any, { name: "shop", project: "shop", slot: null, destination: fakeProject() });
    assert.ok(err && /doesn't stay up/.test(err.message), JSON.stringify(err));

    const steady = new SystemdRunner({ unitDir, node: "/usr/bin/node", settleMs: 5, platform: "linux",
        systemctl: async (args) => args[0] === "show" ? "ActiveState=active\nSubState=running\nMainPID=42\n" : "" });
    assert.equal(await steady.start({ name: "shop" } as any, { name: "shop", project: "shop", slot: null, destination: fakeProject() }), null);
});

test("SystemdRunner: refused off Linux and with bad settings, before anything is written", async () => {
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "units-"));
    const never = async () => { throw new Error("systemctl must not run"); };
    const mac = new SystemdRunner({ unitDir, settleMs: 0, platform: "darwin", systemctl: never });
    assert.match((await mac.start({ name: "shop" } as any, { name: "shop", project: "shop", slot: null, destination: fakeProject() }))!.message, /only on Linux/);
    const linux = new SystemdRunner({ unitDir, node: "/usr/bin/node", settleMs: 0, platform: "linux", systemctl: never });
    const err = await linux.start({ name: "shop", systemd: { env: { A: "x\ny" } } } as any, { name: "shop", project: "shop", slot: null, destination: fakeProject() });
    assert.equal(err?.code, 68);
    assert.deepEqual(fs.readdirSync(unitDir), []);
});
