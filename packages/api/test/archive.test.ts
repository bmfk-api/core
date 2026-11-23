import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DeployerService } from "../src/apiServer/deployment/DeployerService";

const unsafeEntry: (archive: string) => string | null = (DeployerService as any)._unsafeArchiveEntry;
const escapingSymlink: (root: string) => string | null = (DeployerService as any)._escapingSymlink;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bmfk-archive-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function archive(name: string, build: (dir: string) => string[]): string {
    const dir = fs.mkdtempSync(path.join(tmp, "src-"));
    const entries = build(dir);
    const file = path.join(tmp, name);
    execFileSync("tar", ["-czf", file, "-C", dir, ...entries]);
    return file;
}

test("a normal archive is accepted", () => {
    const file = archive("ok.tgz", d => { fs.mkdirSync(path.join(d, "bin")); fs.writeFileSync(path.join(d, "bin", "Main.js"), "1"); return ["bin"]; });
    assert.equal(unsafeEntry(file), null);
});

test("an entry climbing out with .. is rejected", () => {
    const file = archive("dotdot.tgz", d => {
        fs.mkdirSync(path.join(d, "a"));
        fs.writeFileSync(path.join(d, "evil.js"), "1");
        return ["a/../evil.js"];
    });
    assert.ok(unsafeEntry(file));
});

test("a symlink pointing outside the destination is found", () => {
    const root = fs.mkdtempSync(path.join(tmp, "dest-"));
    fs.symlinkSync("/etc/passwd", path.join(root, "passwd"));
    assert.ok(escapingSymlink(root));
});

test("a symlink inside the destination is fine", () => {
    const root = fs.mkdtempSync(path.join(tmp, "dest-"));
    fs.writeFileSync(path.join(root, "a.txt"), "1");
    fs.symlinkSync("a.txt", path.join(root, "b.txt"));
    assert.equal(escapingSymlink(root), null);
});
