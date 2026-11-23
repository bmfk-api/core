import { test } from "node:test";
import assert from "node:assert/strict";
import { PasswordHash } from "../src/apiServer/helper/PasswordHash";
import { IpAllowList } from "../src/apiServer/helper/IpAllowList";

test("a hash verifies its own password and nothing else", async () => {
    const h = await PasswordHash.hash("correct horse battery");
    assert.ok(PasswordHash.isHash(h));
    assert.equal(await PasswordHash.verify("correct horse battery", h), true);
    assert.equal(await PasswordHash.verify("correct horse batterY", h), false);
});

test("the same password hashes differently every time (salt)", async () => {
    assert.notEqual(await PasswordHash.hash("same password 1"), await PasswordHash.hash("same password 1"));
});

test("a plain-text value is not a hash and never verifies", async () => {
    assert.equal(PasswordHash.isHash("hunter2hunter2"), false);
    assert.equal(await PasswordHash.verify("hunter2hunter2", "hunter2hunter2"), false);
});

test("allow-lists match single addresses and CIDR subnets", () => {
    const { list, error } = IpAllowList.build(["203.0.113.7", "10.8.0.0/24"]);
    assert.equal(error, undefined);
    assert.equal(IpAllowList.allows(list, "203.0.113.7"), true);
    assert.equal(IpAllowList.allows(list, "10.8.0.200"), true);
    assert.equal(IpAllowList.allows(list, "10.8.1.1"), false);
    assert.equal(IpAllowList.allows(list, "203.0.113.8"), false);
});

test("an IPv4-mapped IPv6 address matches its IPv4 entry", () => {
    const { list } = IpAllowList.build(["203.0.113.7"]);
    assert.equal(IpAllowList.allows(list, "::ffff:203.0.113.7"), true);
});

test("an invalid entry is an error, not a silent allow", () => {
    assert.ok(IpAllowList.build(["not-an-ip"]).error);
});
