import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ConfigService, projectNameProblem } from "../src/apiServer/deployment/ConfigService";
import { LOG_LEVEL, S_LOG } from "../src/apiServer/LogService";

test("project names that work as a package name and a folder are accepted", () => {
    for (const n of ["api.gateway.newtech.lv", "api.v2.cabinet.impaya.com", "shop", "my-service_2", "0x"])
        assert.equal(projectNameProblem(n), null, n);
});

test("names that would break package.json or folders are refused", () => {
    for (const n of ["", "Shop", "my service", "../etc", ".hidden", "_x", "-x", "a/b", "a\\b", "@scope/x",
                     "name~1", "x".repeat(101), "café", "a\nb"])
        assert.ok(projectNameProblem(n), JSON.stringify(n));
    assert.ok(projectNameProblem(undefined));
    assert.ok(projectNameProblem(42));
});

test("the deployer's own files in the projects folder are not reported; a bad name is reported once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-"));
    fs.writeFileSync(path.join(dir, "shop.json"), JSON.stringify({ name: "shop", token: "scrypt$1" }));
    fs.writeFileSync(path.join(dir, "gate_state_.json"), JSON.stringify({ active: "blue", lastDeployed: "blue", history: [] }));
    fs.writeFileSync(path.join(dir, "setup.json"), JSON.stringify({ users: [] }));
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ name: "Bad Name" }));
    const errors: string[] = [];
    const listener = (l: any) => { if (l.level === LOG_LEVEL.ERROR) errors.push(String(l.data[0])); };
    const id = S_LOG.subscribe(listener);
    try {
        const cs = new ConfigService(dir) as any;
        cs.getConfig();
        cs.getConfig();                                   // the 60 s rescan
        assert.deepEqual([...cs.configurations.keys()], ["shop"]);
        assert.equal(errors.filter(e => e.includes("ignored")).length, 1);
        assert.ok(errors[0].includes("bad.json"));
    } finally {
        S_LOG.unsubscribe(id);
    }
});
