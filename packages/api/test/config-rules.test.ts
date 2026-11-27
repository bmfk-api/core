import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
    buildProject, scryptHash, TScrypt, addDeployerUser, addReviewer, addMonitorUser, addDocumentationUser,
    parseDoc, shellWrite, MIN_PASSWORD_LENGTH, projectNameProblem,
} from "../src/apiServer/deployment/ConfigRules";
import { PasswordHash } from "../src/apiServer/helper/PasswordHash";
import { Validator } from "../src/apiServer/helper/Validator";
import { PROJECT_CONFIG_MODEL } from "../src/apiServer/deployment/ConfigService";
import { SETUP_MODEL } from "../src/apiServer/deployment/DeployerService";
import { AccessStore } from "../src/apiServer/monitor/AccessStore";
import { MonitorAuth } from "../src/apiServer/monitor/MonitorAuth";
import { validateConfig } from "../src/apiServer/deployment/resolveConfig";
import { InterceptorSignedAuth } from "../src/apiServer/interceptors/InterceptorSignedAuth";

// What the website's config generator builds must pass the server's own checks.

const nodeScrypt: TScrypt = (pw, salt, o) => new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, o.dkLen, { N: o.N, r: o.r, p: o.p, maxmem: 256 * o.N * o.r }, (e, k) => e ? reject(e) : resolve(new Uint8Array(k))));

test("scryptHash writes what PasswordHash verifies", async () => {
    const h = await scryptHash(nodeScrypt, "correct horse battery", crypto.randomBytes(16));
    assert.equal(await PasswordHash.verify("correct horse battery", h), true);
    assert.equal(await PasswordHash.verify("wrong", h), false);
});

test("the rules match the server's", () => {
    assert.equal(MIN_PASSWORD_LENGTH, MonitorAuth.MIN_PASSWORD_LENGTH);
    assert.equal(projectNameProblem("api.shop"), null);
    assert.ok(projectNameProblem("Shop"));
});

test("a built project config passes the deployer's schema; its deploy.json passes the client's check", async () => {
    const keys = InterceptorSignedAuth.generateKeyPair();
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = await scryptHash(nodeScrypt, token, crypto.randomBytes(16));
    const base = { name: "shop", destination: "/var/node/shop", host: "https://deploy.example.com/api/pckg/add", login: "ci" };
    for (const a of [
        { ...base, kind: "service" as const },
        { ...base, kind: "static" as const },
        { ...base, kind: "service" as const, omitDev: true, migrate: true, configKeys: ["DB_PASS", "API_KEY"], secrets: true, email: ["ops@example.com"],
          liveness: "http://127.0.0.1:8055/api/liveness", pm2Attributes: ["--max-memory-restart", "300M"],
          bluegreen: { bluePort: "8055", greenPort: "8056", onSwitch: ["/usr/sbin/nginx", "-s", "reload"] },
          nginx: { configDir: "/etc/nginx/node-projects", domain: "shop.example.com" }, review: { reviewers: ["lead"], mode: "all" as const, ttlHours: 24 } },
    ]) {
        const { project, deploy } = buildProject(a, { token, tokenHash, privateKey: keys.privateKey });
        assert.equal(await Validator.validateStructure(PROJECT_CONFIG_MODEL, structuredClone(project)), undefined, a.kind);
        assert.equal(validateConfig(deploy), null);
        assert.equal(await PasswordHash.verify(token, String(project.token)), true);
    }
});

test("setup.json with users and reviewers passes the deployer's schema", async () => {
    let doc: any = parseDoc("").doc;
    doc = addDeployerUser(doc, { login: "ci", publicKey: InterceptorSignedAuth.generateKeyPair().publicKey }).doc;
    doc = addReviewer(doc, { login: "lead", passwordHash: await scryptHash(nodeScrypt, "reviewer password", crypto.randomBytes(16)), email: "lead@example.com" }).doc;
    assert.match(String(addDeployerUser(doc, { login: "ci", publicKey: "x" }).error), /already/);
    assert.match(String(addReviewer(doc, { login: "cto", passwordHash: "x", email: "nope" }).error), /email/);
    assert.equal(await Validator.validateStructure(SETUP_MODEL, structuredClone(doc)), undefined);
    // An existing file keeps what it had.
    const existing = parseDoc(JSON.stringify({ users: [{ login: "old", publicKey: "k" }], allowed_ips: ["10.0.0.0/8"] })).doc!;
    const next = addDeployerUser(existing, { login: "ci", publicKey: "k2" }).doc!;
    assert.deepEqual(next.users.map((u: any) => u.login), ["old", "ci"]);
    assert.deepEqual(next.allowed_ips, ["10.0.0.0/8"]);
});

test("access.json with monitor and documentation users passes the access file's check", async () => {
    const hash = await scryptHash(nodeScrypt, "a long password!", crypto.randomBytes(16));
    let doc: any = parseDoc("").doc;
    doc = addMonitorUser(doc, { login: "ops", passwordHash: hash, role: "admin" }).doc;
    doc = addDocumentationUser(doc, { login: "partner", passwordHash: hash, endpoints: ["/api/v1/payments"] }).doc;
    assert.match(String(addMonitorUser(doc, { login: "a:b", passwordHash: hash, role: "it" }).error), /":"/);
    assert.match(String(addMonitorUser(doc, { login: "x", passwordHash: hash, role: "root" as any }).error), /role/);
    assert.equal(AccessStore.validate(doc), null);
    assert.match(String(parseDoc("{ broken").error), /not valid JSON/);
});

test("shellWrite: one paste writes the file as is, mode 600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shellwrite-"));
    const file = path.join(dir, "sub", "a.json");
    const content = "{\n  \"x\": \"$HOME `id` 'q' BMFK_EOF\"\n}";
    execFileSync("sh", ["-c", shellWrite(file, content)]);
    assert.equal(fs.readFileSync(file, "utf-8"), content + "\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
