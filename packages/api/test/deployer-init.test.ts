import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { deployerInitFiles, nginxSnippet, normalizeBase, publicKeyProblem, IDeployerInitAnswers } from "../src/apiServer/deployment/DeployerInit";
import { InterceptorSignedAuth } from "../src/apiServer/interceptors/InterceptorSignedAuth";
import { exitWhenDone, waitFor } from "./helpers";

exitWhenDone();

const keys = InterceptorSignedAuth.generateKeyPair();

test("input checks: public keys and the base path", () => {
    assert.equal(publicKeyProblem(keys.publicKey), null);
    assert.match(String(publicKeyProblem("hello")), /not a public key/);
    assert.equal(normalizeBase("deployer/v1"), "/deployer/v1/");
    assert.equal(normalizeBase(""), "/");
});

// Runs the generated file against the built package: `npm run build` first (CI does).
const built = fs.existsSync(path.resolve(__dirname, "..", "..", "dist", "index.js"));

test("the generated deployer starts, reads its setup.json and refuses unsigned deploys", { skip: built ? false : "build the package first (npm run build)" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployer-init-"));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "deployer-data-"));
    const a: IDeployerInitAnswers = {
        name: "test-deployer", port: 18815, baseEndPoint: "/api/", maxArchiveMb: 50,
        projectsPath: path.join(data, "projects"), setupPath: path.join(data, "setup"),
        users: [{ login: "ci", publicKey: keys.publicKey }], allowedIps: [], telegram: { bot: "1:x", chat: "-1001" },
    };
    const files = deployerInitFiles(a, JSON.stringify({ name: "tmp", version: "1.0.0", scripts: { test: "echo" } }, null, 2));
    for (const [rel, f] of Object.entries(files)) {
        const target = path.resolve(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content, { mode: f.mode ?? 0o644 });
    }
    fs.mkdirSync(a.projectsPath, { recursive: true });

    const pkg = JSON.parse(files["package.json"].content);
    assert.equal(pkg.name, "test-deployer");
    assert.equal(pkg.main, "bin/Main.js");
    assert.equal(pkg.scripts.test, undefined);
    assert.equal(fs.statSync(path.join(a.setupPath, "setup.json")).mode & 0o777, 0o600);
    assert.ok(!files["bin/Main.js"].content.includes("dist/"));          // public API only
    assert.match(nginxSnippet(a), /client_max_body_size 50m/);

    // @bmfk/api as a project would have it installed
    fs.mkdirSync(path.join(dir, "node_modules", "@bmfk"), { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, "..", ".."), path.join(dir, "node_modules", "@bmfk", "api"));   // packages/api (built)

    const child = spawn(process.execPath, ["bin/Main.js"], { cwd: dir, env: { ...process.env, BMFK_DATA_DIR: data } });
    let out = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => out += d);
    try {
        await waitFor(async () => { try { return (await fetch("http://127.0.0.1:18815/api/liveness")).ok; } catch { return false; } }, 15000);
        const r = await fetch("http://127.0.0.1:18815/api/pckg/status", { method: "POST", headers: { "content-type": "application/json", "x-deployer-login": "ci", authorization: "Bearer x" }, body: "{}" });
        assert.equal(r.status, 401);
        await waitFor(() => /only signed requests|unsigned request/.test(out), 3000);
    } finally {
        child.kill();
    }
});
