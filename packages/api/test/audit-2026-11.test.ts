import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { InterceptorSignedAuth } from "../src/apiServer/interceptors/InterceptorSignedAuth";
import { InterceptorPayAuth } from "../src/apiServer/interceptors/InterceptorPayAuth";
import { LogService } from "../src/apiServer/LogService";
import { MysqlAdapter } from "../src/apiServer/db/MysqlAdapter";
import DefaultErrors from "../src/apiServer/structures/DefaultErrors";
import { transportProblem, validateConfig } from "../src/apiServer/deployment/resolveConfig";
import { DeployerService } from "../src/apiServer/deployment/DeployerService";
import { ReviewAuth } from "../src/apiServer/review/ReviewAuth";
import { ReviewStore } from "../src/apiServer/deployment/ReviewStore";
import { REQ_DEPLOYMENT_CONFIG } from "../src/apiServer/deployment/ConfigService";
import crypto from "crypto";

// Fixes from the 2026-11-25 security review of 1.1.0.

const KEY = "00112233445566778899aabbccddeeff";

test("PayAuth: the interceptor result (what gets logged) has no key; logs mask `key` fields", async () => {
    const auth = new InterceptorPayAuth([{ kid: "k", key: KEY }]);
    const { authorization, b64 } = InterceptorPayAuth.sign({ key: KEY, kid: "k", method: "POST", url: "/api/pay", data: {} });
    const result = await auth.intercept({ method: "POST", headers: { authorization }, data: { b64 }, raw: { originalUrl: "/api/pay" } } as any);
    assert.deepEqual(result, { kid: "k" });
    assert.deepEqual(LogService.sanitizeDeep({ kid: "k", key: KEY, hmacKey: KEY }), { kid: "k", key: "<REDACTED>", hmacKey: "<REDACTED>" });
    assert.ok(!LogService.sanitize(JSON.stringify({ key: KEY })).includes(KEY));
});

const keys = InterceptorSignedAuth.generateKeyPair();
const signed = (body: any, files?: Record<string, string>) =>
    InterceptorSignedAuth.sign({ privateKey: keys.privateKey, kid: "partner", method: "POST", url: "/api/x", data: body, files });
const request = (authorization: string, body: any, files?: any) =>
    ({ method: "POST", headers: { authorization }, data: body, raw: { originalUrl: "/api/x", body, query: {}, files } }) as any;

test("Ed25519: two copies of one request checked at the same time — only one passes", async () => {
    // A slow key lookup keeps both checks in flight together.
    const auth = new InterceptorSignedAuth(kid => new Promise(r => setTimeout(() => r(kid === "partner" ? keys.publicKey : null), 30)));
    const h = signed({ a: 1 });
    const [x, y] = await Promise.all([auth.verify(request(h, { a: 1 })), auth.verify(request(h, { a: 1 }))]);
    assert.equal([x, y].filter(v => v.kid === "partner").length, 1);
    assert.match(([x, y].find(v => !v.kid))!.error!, /already used/);
});

test("Ed25519: a request accepted by one interceptor is refused by another in the same process", async () => {
    const h = signed({ b: 1 });
    assert.equal((await new InterceptorSignedAuth(() => keys.publicKey).verify(request(h, { b: 1 }))).kid, "partner");
    assert.match((await new InterceptorSignedAuth(() => keys.publicKey).verify(request(h, { b: 1 }))).error!, /already used/);
});

test("Ed25519: a field with several files is refused — only one hash per field is signed", async () => {
    const one = { data: Buffer.from("first") }, two = { data: Buffer.from("second") };
    const sha = (b: Buffer) => require("crypto").createHash("sha256").update(b).digest("hex");
    const h = signed({}, { doc: sha(one.data) });
    const v = await new InterceptorSignedAuth(() => keys.publicKey).verify(request(h, {}, { doc: [one, two] }));
    assert.equal(v.kid, undefined);
    assert.match(v.error!, /one file per field/);
    const h1 = signed({}, { doc: sha(one.data) });
    assert.equal((await new InterceptorSignedAuth(() => keys.publicKey).verify(request(h1, {}, { doc: [one] }))).kid, "partner");
});

test("MySQL, throwable: the driver's message stays out of the error the client gets", async () => {
    const adapter = new MysqlAdapter({} as any);
    const conn: any = { query: async () => { throw { code: "ER_NO_SUCH_TABLE", errno: 1146, message: "Table 'pay.secret_table' doesn't exist", sqlMessage: "Table 'pay.secret_table' doesn't exist" }; }, release() {} };
    for (const onErrorText of [undefined, "Can't save"]) {
        try { await adapter.query({ query: "SELECT 2", throwable: true, onErrorText }, conn); assert.fail("no throw"); }
        catch (e: any) {
            assert.equal(e.code, DefaultErrors.DB_ERROR.code);
            assert.equal(e.details, undefined);
            const { stack, ...client } = e;
            assert.ok(!JSON.stringify(client).includes("secret_table"));
            if (onErrorText) assert.equal(e.message, onErrorText);
        }
    }
});

test("deploy addresses: https, or http to this machine only", () => {
    assert.equal(transportProblem("https://deploy.example.com/api/pckg/add"), null);
    assert.equal(transportProblem("http://127.0.0.1:9915/api/pckg/add"), null);
    assert.equal(transportProblem("http://localhost:9915/api/review/html"), null);
    assert.equal(transportProblem("http://[::1]:9915/x"), null);
    assert.match(String(transportProblem("http://deploy.example.com/api/pckg/add")), /must be https/);
    assert.match(String(transportProblem("http://127.0.0.1.example.com/x")), /must be https/);
    const cfg = { name: "a", token: "t", username: "u", password: "p" };
    assert.match(String(validateConfig({ ...cfg, host: "http://10.0.0.5:9915/api/pckg/add" })), /host: .*must be https/);
    assert.equal(validateConfig({ ...cfg, host: "https://deploy.example.com/api/pckg/add" }), null);
});

test("secrets on: a value that would be written into the code stops the deploy, the file stays as it was", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-code-"));
    const file = path.join(dir, "Config.mjs");
    const before = `export const db = "_{{DB_PASS}}_";\n`;
    fs.writeFileSync(file, before);
    const svc = Object.create(DeployerService.prototype) as DeployerService;
    await assert.rejects(svc.processFile(file, { DB_PASS: "hunter2" }, { secretsFile: path.join(dir, "s.json"), onDisk: [] }),
        (e: any) => e.code === 68 && /Config\.mjs/.test(e.details));
    assert.equal(fs.readFileSync(file, "utf-8"), before);
    // Without secrets the value is substituted, as before.
    await svc.processFile(file, { DB_PASS: "hunter2" }, { secretsFile: null, onDisk: [] });
    assert.match(fs.readFileSync(file, "utf-8"), /hunter2/);
});

test("reviewers' 2FA store: missing means not enrolled, damaged refuses sign-in instead of offering a new enrollment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-2fa-"));
    const auth = new ReviewAuth(new ReviewStore(dir), () => []) as any;
    assert.equal(auth.secretFor("lead"), null);
    fs.mkdirSync(path.join(dir, ".review"), { recursive: true });
    const store = path.join(dir, ".review", "reviewers-2fa.json");
    fs.writeFileSync(store, "{ not json");
    assert.throws(() => auth.secretFor("lead"), /damaged/);
    auth.enrollments.set("t", { login: "lead", secret: "JBSWY3DPEHPK3PXP", link: {}, createdAt: Date.now() });
    assert.match(auth.enroll("t", "000000").error, /operator/);
    assert.equal(fs.readFileSync(store, "utf-8"), "{ not json");
});

test("deploy review: only the approved archive is installed, and the project stays busy until the deploy takes over", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-race-"));
    const reviews = new ReviewStore(dir);
    fs.mkdirSync(reviews.dir, { recursive: true });
    const put = (content: string) => {
        fs.writeFileSync(reviews.archivePath("shop"), content);
        const sha256 = crypto.createHash("sha256").update(content).digest("hex");
        reviews.save({ project: "shop", state: "deploying", sha256, size: content.length, uploadedBy: "ci", uploadedFrom: null,
            uploadedAt: Date.now(), expiresAt: Date.now() + 3600_000, mode: "any", reviewers: { lead: { tokenHash: "x", decision: "accept" } as any } });
        return sha256;
    };
    const svc = Object.create(DeployerService.prototype) as any;
    svc.busy = new Map<string, boolean>();
    svc.reviews = reviews;
    const deployed: { busyAtCall: boolean }[] = [];
    svc._deploy = async () => { deployed.push({ busyAtCall: !!svc.busy.get("shop") }); svc.busy.set("shop", true); svc.busy.set("shop", false); return { data: {} }; };
    REQ_DEPLOYMENT_CONFIG.listener = async () => new Map([["shop", { name: "shop", review: { reviewers: ["lead"] } } as any]]);

    // Approved A, but the pending upload is now B: nothing is installed.
    const approved = put("archive A");
    put("archive B");
    svc.busy.set("shop", true);
    await svc._deployApproved("shop", ["lead"], approved);
    assert.equal(deployed.length, 0);
    assert.equal(svc.busy.get("shop"), false);
    assert.ok(fs.readFileSync(path.join(reviews.dir, "shop.history.jsonl"), "utf-8").includes("not the approved one"));

    // The approved one: installed, and the busy flag is handed to _deploy, not dropped earlier.
    const ok = put("archive C");
    svc.busy.set("shop", true);
    const run = svc._deployApproved("shop", ["lead"], ok);
    assert.equal(svc.busy.get("shop"), true);   // an upload now gets "Deployment already in progress"
    await run;
    assert.deepEqual(deployed, [{ busyAtCall: false }]);
    assert.equal(reviews.get("shop")?.state, "deployed");
});
