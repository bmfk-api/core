import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { MonitorService } from "../src/apiServer/MonitorService";
import { AppData } from "../src/apiServer/helper/AppDataPath";
import { DeployerService } from "../src/apiServer/deployment/DeployerService";
import { exitWhenDone, waitFor } from "./helpers";

exitWhenDone();

const countEp = (m: MonitorService, ep: string) => {
    let n = 0;
    for (const day of m.slots.values()) for (const s of day.values()) n += s.successEp[ep] ?? 0;
    return n;
};

test("metrics survive a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-"));
    const first = new MonitorService(dir);
    await first.init();
    await waitFor(() => (first as any)._live === true);
    first.onStatRegistrate({ endpoint: "pay" } as any);
    first.onStatRegistrate({ endpoint: "pay" } as any);
    await first.finishService();                       // what SIGINT/SIGTERM does
    assert.ok(fs.readdirSync(dir).some(f => f.endsWith(".jsonl")));

    const second = new MonitorService(dir);
    await second.init();
    assert.equal(countEp(second, "pay"), 2);
});

test("a process that is not live does not write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-"));
    const m = new MonitorService(dir);
    await m.init();
    await waitFor(() => (m as any)._live === true);
    (m as any)._live = false;                          // standby slot
    m.onStatRegistrate({ endpoint: "x" } as any);
    await m.finishService();
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).length, 0);
});

test("default folder: <root>/<project>/<sub>, one per project", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmfk-"));
    const saved = process.env.BMFK_DATA_DIR;
    process.env.BMFK_DATA_DIR = root;
    try {
        assert.equal(AppData.projectDir("api.gateway.newtech.lv"), path.join(root, "api.gateway.newtech.lv"));
        assert.equal(AppData.projectDir("@scope/my api"), path.join(root, "my_api"));
        const dir = AppData.dir("metrics")!;
        assert.equal(dir, path.join(root, AppData.project(), "metrics"));   // package.json name of whatever runs the test
        assert.equal((fs.statSync(path.dirname(dir)).mode & 0o777), 0o700);
    } finally {
        process.env.BMFK_DATA_DIR = saved;
    }
});

test("the deployer writes its project name into the deployed package.json and lock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-"));
    fs.writeFileSync(path.join(dir, "package.json"), '{\n\t"name": "gateway",\n\t"version": "1.0.0"\n}\n');
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "gateway", lockfileVersion: 3, packages: { "": { name: "gateway" } } }, null, 2));
    DeployerService._stampProjectName(dir, "api.example.com");
    const pkg = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    assert.equal(JSON.parse(pkg).name, "api.example.com");
    assert.ok(pkg.startsWith('{\n\t"name"'));                        // indentation kept
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf-8"));
    assert.equal(lock.name, "api.example.com");
    assert.equal(lock.packages[""].name, "api.example.com");

    DeployerService._stampProjectName(dir, "Not Valid");               // left alone, no throw
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).name, "api.example.com");
});
