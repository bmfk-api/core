import "./helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { legacyRootInUse, homeRoot } from "../src/apiServer/helper/AppDataPath";
import { planMove, moveOne } from "../src/apiServer/deployment/DataMove";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("data root: ~/.bmfk by default", () => {
    assert.equal(homeRoot(), path.join(os.homedir(), ".bmfk"));
});

test("data root: /var/bmfk counts while it holds a real project folder, not links or files", () => {
    const legacy = tmp("legacy-");
    assert.equal(legacyRootInUse(legacy), false);
    fs.writeFileSync(path.join(legacy, "note.txt"), "");
    assert.equal(legacyRootInUse(legacy), false);
    fs.symlinkSync(tmp("elsewhere-"), path.join(legacy, "shop"), "dir");
    assert.equal(legacyRootInUse(legacy), false);
    fs.mkdirSync(path.join(legacy, "ledger"));
    assert.equal(legacyRootInUse(legacy), true);
    assert.equal(legacyRootInUse(path.join(legacy, "missing")), false);
});

test("data move: each project folder moves and leaves a link; existing data and links are left alone", () => {
    const from = tmp("legacy-"), to = path.join(tmp("home-"), ".bmfk");
    fs.mkdirSync(path.join(from, "shop", "metrics"), { recursive: true });
    fs.writeFileSync(path.join(from, "shop", "secrets-blue.json"), '{"a":1}');
    fs.writeFileSync(path.join(from, "shop", "metrics", "w1.json"), "[]");
    fs.mkdirSync(path.join(from, "ledger"));
    fs.mkdirSync(path.join(to, "ledger"), { recursive: true });
    fs.writeFileSync(path.join(to, "ledger", "access.json"), "{}");
    fs.symlinkSync(tmp("x-"), path.join(from, "old"), "dir");

    const plan = planMove(from, to);
    const by = Object.fromEntries(plan.items.map(i => [i.name, i]));
    assert.equal(by.shop.action, "move");
    assert.equal(by.ledger.action, "skip");
    assert.match(by.ledger.why!, /already has files/);
    assert.equal(by.old.action, "skip");

    moveOne(by.shop);
    assert.equal(fs.readFileSync(path.join(to, "shop", "secrets-blue.json"), "utf-8"), '{"a":1}');
    assert.ok(fs.lstatSync(path.join(from, "shop")).isSymbolicLink());
    // The old absolute path still reads the moved file.
    assert.equal(fs.readFileSync(path.join(from, "shop", "secrets-blue.json"), "utf-8"), '{"a":1}');
    assert.equal(fs.statSync(path.join(to, "shop")).mode & 0o777, 0o700);
    assert.equal(legacyRootInUse(from), true);   // ledger is still a real folder there
    assert.equal(planMove(from, to).items.find(i => i.name === "shop")!.action, "skip");
});
