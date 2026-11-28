import "./helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { logLine, LOG_LEVEL, ILogItem } from "../src/apiServer/LogService";
import { ProcessMonitor } from "../src/apiServer/monitor/ProcessMonitor";
import { journalEntry, ownUnit } from "../src/apiServer/monitor/LogFiles";

const item = (level: LOG_LEVEL): ILogItem => ({ id: 1, level, time: 0, text: "disk almost full", date: "2026-11-27 10:00:00", source: "", repeat: 0 });

test("logLine: the journald level only when stdout goes to the journal", () => {
    assert.equal(logLine(item(LOG_LEVEL.WARN), {}), "2026-11-27 10:00:00 WARN disk almost full");
    assert.equal(logLine(item(LOG_LEVEL.WARN), { JOURNAL_STREAM: "8:123" }), "<4>2026-11-27 10:00:00 WARN disk almost full");
    assert.ok(logLine(item(LOG_LEVEL.ERROR), { JOURNAL_STREAM: "8:1" }).startsWith("<3>"));
    assert.ok(logLine(item(LOG_LEVEL.CRIT), { JOURNAL_STREAM: "8:1" }).startsWith("<2>"));
    assert.ok(logLine(item(LOG_LEVEL.INFO), { JOURNAL_STREAM: "8:1" }).startsWith("<6>"));
});

test("supervisor: the deployer's unit, pm2, or nothing (then the monitor won't restart)", () => {
    const saved = { ...process.env };
    try {
        for (const k of ["INVOCATION_ID", "BMFK_UNIT", "pm_id", "name"]) delete process.env[k];
        assert.deepEqual(ProcessMonitor.getSupervisor(), { kind: null, managed: false, name: null, unit: null, pmId: null });
        process.env.BMFK_UNIT = "bmfk-shop-blue.service";
        assert.equal(ProcessMonitor.getSupervisor().managed, false);      // not started by systemd
        process.env.INVOCATION_ID = "abc";
        assert.deepEqual(ProcessMonitor.getSupervisor(), { kind: "systemd", managed: true, name: "shop-blue", unit: "bmfk-shop-blue.service", pmId: null });
        process.env.BMFK_UNIT = "sshd.service";
        assert.equal(ProcessMonitor.getSupervisor().managed, false);
        process.env.pm_id = "3"; process.env.name = "shop";
        assert.deepEqual(ProcessMonitor.getSupervisor(), { kind: "pm2", managed: true, name: "shop", unit: null, pmId: "3" });
        assert.equal(ownUnit({ INVOCATION_ID: "x", BMFK_UNIT: "bmfk-shop.service" }), "bmfk-shop.service");
        assert.equal(ownUnit({ BMFK_UNIT: "bmfk-shop.service" }), null);
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test("journal entries for the monitor: time, level, text", () => {
    const e = journalEntry(JSON.stringify({ __REALTIME_TIMESTAMP: "1795000000123000", PRIORITY: "3", MESSAGE: "db down" }))!;
    assert.equal(e.us, 1795000000123000);
    assert.match(e.line, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.123 ERROR db down$/);
    assert.equal(journalEntry("{}"), null);
    assert.equal(journalEntry("nope"), null);
});
