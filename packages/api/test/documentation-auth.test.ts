import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { PasswordHash } from "../src/apiServer/helper/PasswordHash";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

// RFC 6238 code for a base32 secret, as an authenticator app computes it.
function totp(secret: string, at = Date.now()): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const c of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
    const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
    const h = crypto.createHmac("sha1", key).update(counter).digest();
    const o = h[h.length - 1] & 0xf;
    return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}

const PORT = 18813;
const B = `http://localhost:${PORT}/api`;
const PASSWORD = "partner-password-1";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-auth-"));
const accessFile = path.join(dir, "access.json");

const ready = (async () => {
    fs.writeFileSync(accessFile, JSON.stringify({
        documentation: [{ login: "partner", password: await PasswordHash.hash(PASSWORD) }, { login: "legacy", password: "plain-text-pass" }],
    }));
    return startApi(PORT, [], { access: accessFile, monitorAuthFile: path.join(dir, "2fa.json") });
})();

const post = async (ep: string, body: unknown = {}, token?: string) => {
    const r = await fetch(`${B}/${ep}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
};

let session = "";

test("the documentation needs a session; the old sha256(login:password) bearer no longer works", async () => {
    await ready;
    assert.equal((await post("doc/json")).status, 401);
    const old = crypto.createHash("sha256").update("legacy:plain-text-pass").digest("hex");
    assert.equal((await post("doc/json", {}, old)).status, 401);
});

test("first sign-in enrolls 2FA, then the session reads the documentation", async () => {
    await ready;
    const first = await post("doc/login", { login: "partner", password: PASSWORD });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.enrollmentRequired, true);
    assert.match(first.body.data.otpauthUri, /partner/);
    assert.doesNotMatch(first.body.data.otpauthUri, /doc%3A|doc:/);         // the app shows the plain login
    const enrolled = await post("doc/enroll2fa", { enrollmentToken: first.body.data.enrollmentToken, totp: totp(first.body.data.secret) });
    assert.equal(enrolled.status, 200);
    session = enrolled.body.data.token;
    assert.equal(enrolled.body.data.idleTimeoutMs, 15 * 60 * 1000);
    const doc = await post("doc/json", {}, session);
    assert.equal(doc.status, 200);
    assert.ok(Array.isArray(doc.body.data));
});

test("a plain-text password in the config is refused", async () => {
    await ready;
    assert.equal((await post("doc/login", { login: "legacy", password: "plain-text-pass" })).status, 401);
});

test("a documentation session does not open the monitor", async () => {
    await ready;
    assert.equal((await post("sm/sysinfo", {}, session)).status, 401);
});

test("signing out ends the session", async () => {
    await ready;
    await post("doc/logout", {}, session);
    assert.equal((await post("doc/json", {}, session)).status, 401);
});

test("ten wrong passwords lock the account", async () => {
    await ready;
    for (let i = 0; i < 10; i++) await post("doc/login", { login: "partner", password: "wrong" });
    const r = await post("doc/login", { login: "partner", password: PASSWORD });
    assert.equal(r.status, 401);
    assert.match(String(r.body.error.details), /locked/);
});
