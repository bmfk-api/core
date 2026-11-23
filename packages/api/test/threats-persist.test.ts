import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ThreatMonitor } from "../src/apiServer/monitor/ThreatMonitor";
import { exitWhenDone, waitFor } from "./helpers";

exitWhenDone();

test("threats survive a restart", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "threats-")), "threats.json");
    ThreatMonitor.reset();
    ThreatMonitor.configure(file);
    await waitFor(() => (ThreatMonitor as any).writer === true);

    ThreatMonitor.observe({ ip: "203.0.113.7", method: "GET", url: "/.env", status: 404 });
    ThreatMonitor.observe({ ip: "203.0.113.7", method: "GET", url: "/wp-login.php", status: 404 });
    assert.equal(ThreatMonitor.save(), true);
    assert.equal(ThreatMonitor.save(), false);                     // nothing new: no rewrite
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const before = ThreatMonitor.snapshot();
    (ThreatMonitor as any).records.clear();                        // "restart"
    (ThreatMonitor as any).events = [];
    ThreatMonitor.configure(file);
    const after = ThreatMonitor.snapshot();
    assert.equal(after.offenders.length, 1);
    assert.equal(after.offenders[0].ip, "203.0.113.7");
    assert.equal(after.offenders[0].hits, 2);
    assert.equal(after.recent.length, before.recent.length);
    assert.ok(!fs.readFileSync(file, "utf-8").includes("body"));
});

test("a broken file is ignored, not fatal", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "threats-")), "threats.json");
    fs.writeFileSync(file, "{not json");
    ThreatMonitor.reset();
    assert.doesNotThrow(() => ThreatMonitor.configure(file));
    assert.equal(ThreatMonitor.snapshot().offenders.length, 0);
});
