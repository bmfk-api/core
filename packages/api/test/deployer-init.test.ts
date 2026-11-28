import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { deployerUnit, deployerInitFiles, findDeployer, nginxSnippet, normalizeBase, publicKeyProblem, IDeployerInitAnswers } from "../src/apiServer/deployment/DeployerInit";
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

test("the wizards find the deployer's folders in the generated bin/Main.js", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployer-find-"));
    const a: IDeployerInitAnswers = {
        name: "d", port: 9915, baseEndPoint: "/deploy/", maxArchiveMb: 10,
        projectsPath: "/srv/my \"deployer\"/projects", setupPath: "/srv/my \"deployer\"/setup",
        users: [{ login: "ci", publicKey: keys.publicKey }], allowedIps: [],
    };
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "Main.js"), deployerInitFiles(a, null)["bin/Main.js"].content);
    assert.deepEqual(findDeployer(dir), { projectsPath: a.projectsPath, setupPath: a.setupPath, baseEndPoint: "/deploy/" });

    const prev = process.env.BMFK_DATA_DIR;
    process.env.BMFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deployer-root-"));
    try {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "deployer-none-"));
        assert.equal(findDeployer(empty), null);
        fs.mkdirSync(path.join(process.env.BMFK_DATA_DIR, "bmfk-deployer", "projects"), { recursive: true });
        assert.equal(findDeployer(empty)?.projectsPath, path.join(process.env.BMFK_DATA_DIR, "bmfk-deployer", "projects"));
    } finally {
        if (prev === undefined) delete process.env.BMFK_DATA_DIR; else process.env.BMFK_DATA_DIR = prev;
    }
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

test("deployer-init with systemd: a unit without sandbox (it writes the projects), started at boot; no pm2 file", () => {
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "units-"));
    const a: IDeployerInitAnswers = {
        name: "bmfk-deployer", runner: "systemd", port: 9915, baseEndPoint: "/api/", maxArchiveMb: 100,
        projectsPath: "/home/deploy/.bmfk/bmfk-deployer/projects", setupPath: "/home/deploy/.bmfk/bmfk-deployer/setup",
        users: [{ login: "ci", publicKey: keys.publicKey }], allowedIps: [],
    };
    const u = deployerUnit(a, "/home/deploy/deployer", "/usr/bin/node", unitDir);
    assert.equal(u.file, path.join(unitDir, "bmfk-bmfk-deployer.service"));
    const lines = u.text!.split("\n");
    for (const l of ["ExecStart=/usr/bin/node /home/deploy/deployer/bin/Main.js", "WorkingDirectory=/home/deploy/deployer",
        "X-Bmfk-Role=deployer", "X-Bmfk-Port=9915", 'Environment="NODE_ENV=production"', "Restart=always", "WantedBy=default.target"])
        assert.ok(lines.includes(l), l);
    assert.ok(!u.text!.includes("NoNewPrivileges"));     // its switch hook may use sudo
    assert.ok(!u.text!.includes("ProtectSystem"));
    const files = deployerInitFiles(a, null);
    assert.equal(files["ecosystem.config.cjs"], undefined);
    assert.match(files["bin/Main.js"].content, /runs under systemd \(bmfk-bmfk-deployer\.service/);
    assert.ok(deployerInitFiles({ ...a, runner: "pm2" }, null)["ecosystem.config.cjs"]);
});
