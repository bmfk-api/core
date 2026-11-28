import fs from "fs";
import net from "net";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { stdin as input } from "process";
import { AppData } from "../helper/AppDataPath";
import { IpAllowList } from "../helper/IpAllowList";
import { projectNameProblem } from "./ConfigService";
import { askHidden } from "./HashPassword";
import { palette } from "./cliCommon";
import { ask, askValid, yes, list } from "./cliPrompt";
import { allocateId, listUnits, renderUnit, unitName, userUnitDir } from "./SystemdUnit";
import { realSystemctl } from "./SystemdRunner";
import { controlSocketPath } from "../control/Control";
import { Ps } from "./Ps";

// `bmfk deployer-init` — turns an empty folder on the server into a running deployer:
//   bin/Main.js        the service (public API of @bmfk/api only)
//   ~/.config/systemd/user/bmfk-<name>.service   how systemd runs it (Linux, the default), or
//   ecosystem.config.cjs                          how pm2 runs it
//   package.json           name, main, start script
//   <setup>/setup.json     who may deploy (mode 600), in the deployer's data folder
//   <projects>/            where project configs go (bmfk project-config writes them)
// Run it in the folder where `npm i @bmfk/api` was done. It never overwrites without asking.

export interface IDeployerInitAnswers {
    name: string;                 // process name and package.json name; also its data folder
    runner?: "systemd" | "pm2";   // default pm2 (as before 1.2.0)
    port: number;
    baseEndPoint: string;         // "/api/" → deploys go to <domain>/api/pckg/add
    maxArchiveMb: number;
    projectsPath: string;
    setupPath: string;
    users: { login: string, publicKey: string }[];
    allowedIps: string[];
    telegram?: { bot: string, chat: string };
}

const DEFAULT_PORT = 9915;

/** Ed25519 public key, base64 SPKI — what `bmfk deploy-key` prints. Null when it is one. */
export function publicKeyProblem(key: string): string | null {
    try {
        const k = crypto.createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
        return k.asymmetricKeyType === "ed25519" ? null : `an ${k.asymmetricKeyType} key — deploy keys are Ed25519`;
    } catch {
        return "not a public key — paste what `npx bmfk deploy-key` printed";
    }
}

export function normalizeBase(base: string): string {
    let b = base.trim() || "/";
    if (!b.startsWith("/")) b = "/" + b;
    if (!b.endsWith("/")) b += "/";
    return b;
}

/** The files to write: path relative to the folder (or absolute) → content and mode. */
export function deployerInitFiles(a: IDeployerInitAnswers, packageJson: string | null): Record<string, { content: string, mode?: number }> {
    const main = `"use strict";
// The deployer — written by \`bmfk deployer-init\`. It runs under ${a.runner === "systemd" ? `systemd (${unitName(a.name)}, bmfk ps)` : "pm2 (ecosystem.config.cjs)"} as the user
// that owns the deployed projects. Who may deploy: ${path.join(a.setupPath, "setup.json")}
// (npx bmfk setup-config ${a.setupPath}); project configs: ${a.projectsPath} (npx bmfk project-config).
const { APIService, Initializer, LogService, getDefaultOptions, getDefaultLogOptions, logLine } = require("@bmfk/api");

const logOptions = getDefaultLogOptions();
logOptions.output = item => console.log(logLine(item));   // with the level for journald under systemd

Initializer([
    new LogService(logOptions),
    new APIService(getDefaultOptions({
        port: ${a.port},
        baseEndPoint: ${JSON.stringify(a.baseEndPoint)},
        projectName: ${JSON.stringify(a.name)},
        fileLimit: ${a.maxArchiveMb} * 1024 * 1024,   // the largest deploy archive accepted
        deployer: {
            projects_path: ${JSON.stringify(a.projectsPath)},
            setup_path: ${JSON.stringify(a.setupPath)},
        },
    })),
]);
`;
    const ecosystem = `// pm2 process of the deployer — written by \`bmfk deployer-init\`.
//   pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
    apps: [{
        name: ${JSON.stringify(a.name)},
        script: "bin/Main.js",
        cwd: __dirname,
        autorestart: true,
        env: { NODE_ENV: "production" },
    }],
};
`;
    let pkg: any = {};
    let indent: string | number = 2;
    if (packageJson) {
        pkg = JSON.parse(packageJson);
        indent = packageJson.match(/^[ \t]+(?=")/m)?.[0] ?? 2;
    }
    pkg.name = a.name;
    pkg.private = true;
    pkg.main = "bin/Main.js";
    pkg.scripts = { ...(pkg.scripts ?? {}), start: "node bin/Main.js" };
    delete pkg.scripts.test;   // npm init's placeholder

    const setup: any = { users: a.users };
    if (a.allowedIps.length) setup.allowed_ips = a.allowedIps;
    if (a.telegram) setup.telegram = a.telegram;

    return {
        "bin/Main.js": { content: main },
        ...(a.runner === "systemd" ? {} : { "ecosystem.config.cjs": { content: ecosystem } }),
        "package.json": { content: JSON.stringify(pkg, null, indent) + "\n" },
        [path.join(a.setupPath, "setup.json")]: { content: JSON.stringify(setup, null, 4) + "\n", mode: 0o600 },
    };
}

/** The deployer's own systemd user unit: no sandbox (see SystemdUnit), restarts always, starts at boot. */
export function deployerUnit(a: IDeployerInitAnswers, dir: string, node = process.execPath, unitDir = userUnitDir()): { file: string, text?: string, problems?: string[] } {
    const r = renderUnit({
        id: allocateId(a.name, listUnits(unitDir)), name: a.name, project: a.name, slot: null, port: String(a.port),
        workingDirectory: path.resolve(dir), node, entry: path.resolve(dir, "bin", "Main.js"), sourceMaps: false,
        dataDir: AppData.projectDir(a.name), control: controlSocketPath(a.name, null),
        settings: { env: { NODE_ENV: "production" } }, deployer: true,
    });
    return { file: path.join(unitDir, unitName(a.name)), ...r };
}

export interface IDeployerFolders { projectsPath: string, setupPath: string, baseEndPoint: string }

/**
 * The folders of a deployer made by deployer-init: read from <dir>/bin/Main.js, else the default
 * <data folder>/bmfk-deployer when it exists. Null when neither is found.
 */
export function findDeployer(dir: string): IDeployerFolders | null {
    let main = "";
    try { main = fs.readFileSync(path.join(dir, "bin", "Main.js"), "utf-8"); } catch { }
    const str = (key: string): string | null => {
        const m = main.match(new RegExp(`\\b${key}:\\s*("(?:[^"\\\\]|\\\\.)*")`));
        try { return m ? String(JSON.parse(m[1])) : null; } catch { return null; }
    };
    const projectsPath = str("projects_path"), setupPath = str("setup_path");
    if (projectsPath && setupPath) return { projectsPath, setupPath, baseEndPoint: str("baseEndPoint") ?? "/api/" };
    const def = AppData.projectDir("bmfk-deployer");
    if (fs.existsSync(path.join(def, "projects")))
        return { projectsPath: path.join(def, "projects"), setupPath: path.join(def, "setup"), baseEndPoint: "/api/" };
    return null;
}

export function nginxSnippet(a: IDeployerInitAnswers): string {
    return `location ${a.baseEndPoint}pckg/ {
    proxy_pass http://127.0.0.1:${a.port};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size ${a.maxArchiveMb}m;
    proxy_read_timeout 600s;          # npm ci and the build of a deploy take a while
}`;
}

const portFree = (port: number) => new Promise<boolean>(resolve => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
});

function pm2Version(): string | null {
    try { return execFileSync("pm2", ["-v"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

export async function DeployerInit(args: string[]): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ deployer-init is interactive — run it in a terminal on the server."));
        process.exit(1);
    }
    const dir = path.resolve(args[0] ?? ".");
    console.log(bold(`\nbmfk deployer-init — ${dir}\n`));

    // ---- the machine ----
    if (process.getuid?.() === 0) {
        console.error(red("✗ running as root. The deployer must run as the user that owns the deployed projects (and pm2) — switch to it."));
        process.exit(1);
    }
    if (!fs.existsSync(path.join(dir, "node_modules", "@bmfk", "api"))) {
        console.error(red(`✗ @bmfk/api is not installed in ${dir}. First: npm init -y && npm i @bmfk/api`));
        process.exit(1);
    }
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    console.log(`  ${nodeMajor >= 24 ? green("✓") : red("✗")} Node.js ${process.versions.node}${nodeMajor >= 24 ? "" : " — @bmfk/api needs 24 or later"}`);
    const pm2 = pm2Version();
    let systemd = false;
    if (process.platform === "linux") {
        try { await realSystemctl(["--version"]); await realSystemctl(["is-system-running"]).catch((e: any) => { if (!String(e?.stdout ?? "").trim()) throw e; }); systemd = true; } catch { }
        console.log(`  ${systemd ? green("✓") : yellow("!")} systemd user manager ${systemd ? "reachable" : "not reachable — log in as this user directly (ssh), not via su/sudo; or use pm2"}`);
    }
    console.log(`  ${pm2 ? green("✓") : dim("–")} pm2 ${pm2 ?? (systemd ? "not installed (not needed with systemd)" : "not found — install it: npm i -g pm2")}`);
    const root = AppData.root();
    try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch { }
    let rootOk = true;
    try { fs.accessSync(root, fs.constants.W_OK); } catch { rootOk = false; }
    console.log(`  ${rootOk ? green("✓") : yellow("!")} data folder ${root} ${rootOk ? "writable" : "can't be created or written — set BMFK_DATA_DIR to a folder this user owns"}`);
    if (!rootOk && !(await yes("  continue anyway (folders are asked next)?", false))) return;

    // ---- the service ----
    console.log(bold("\nThe service"));
    let runner: "systemd" | "pm2" = "pm2";
    if (systemd)
        runner = (await askValid("  run it with systemd (starts at boot, bmfk ps) or pm2", "systemd", v => v === "systemd" || v === "pm2" ? null : "systemd or pm2")) as "systemd" | "pm2";
    else if (!pm2) {
        console.error(red("✗ neither systemd (user manager) nor pm2 is available to run the deployer."));
        process.exit(1);
    }
    const name = await askValid("  name (process, data folder)", "bmfk-deployer", v => projectNameProblem(v));
    let port = 0;
    for (;;) {
        port = Number(await askValid("  port (local; nginx proxies to it)", String(DEFAULT_PORT), v => /^\d+$/.test(v) && +v > 0 && +v < 65536 ? null : "a port number"));
        if (await portFree(port)) break;
        console.log(red(`  ✗ port ${port} is in use`));
    }
    const baseEndPoint = normalizeBase(await ask("  base path (deploys go to <domain><base>pckg/add)", "/api/"));
    const maxArchiveMb = Number(await askValid("  largest deploy archive, MB", "100", v => /^\d+$/.test(v) && +v > 0 ? null : "a number"));
    const dataDir = path.join(root, name);
    const projectsPath = path.resolve(await ask("  project configs folder", path.join(dataDir, "projects")));
    const setupPath = path.resolve(await ask("  setup.json folder", path.join(dataDir, "setup")));

    // ---- who may deploy ----
    console.log(bold("\nWho may deploy") + dim("  (signed requests only; more users later: npx bmfk setup-config " + setupPath + ")"));
    console.log(dim("  On the machine you deploy from, in the project: npx bmfk deploy-key — it prints the public key."));
    const users: { login: string, publicKey: string }[] = [];
    while (users.length === 0 || await yes("  add another user?", false)) {
        const login = await askValid("  login", users.length ? "" : "ci", v => !v ? "required" : v.includes(":") ? "no ':' in logins" : users.some(u => u.login === v) ? "already added" : null);
        const publicKey = await askValid("  public key", "", v => publicKeyProblem(v));
        users.push({ login, publicKey });
    }
    const allowedIps = list(await askValid("  addresses allowed to deploy (IPs / subnets, comma-separated; empty = any)", "",
        v => !v.trim() ? null : IpAllowList.build(list(v)).error ?? null));

    // ---- telegram ----
    let telegram: { bot: string, chat: string } | undefined;
    if (await yes("\nPost deploy events to a Telegram chat?", false)) {
        const bot = (await askHidden("  bot token (hidden): ")).trim();
        const chat = await askValid("  chat id (a group starts with -100)", "", v => /^-?\d+$/.test(v) ? null : "a number");
        if (bot) telegram = { bot, chat };
    }

    const answers: IDeployerInitAnswers = { name, runner, port, baseEndPoint, maxArchiveMb, projectsPath, setupPath, users, allowedIps, telegram };
    const pkgFile = path.join(dir, "package.json");
    const files = deployerInitFiles(answers, fs.existsSync(pkgFile) ? fs.readFileSync(pkgFile, "utf-8") : null);

    // ---- write ----
    console.log(bold("\nFiles"));
    for (const [rel, f] of Object.entries(files)) {
        const target = path.resolve(dir, rel);
        if (fs.existsSync(target) && rel !== "package.json") {
            if (fs.readFileSync(target, "utf-8") === f.content) { console.log(dim(`  = ${target} (unchanged)`)); continue; }
            if (!(await yes(`  ${target} exists — replace it?`, false))) { console.log(yellow(`  ! kept ${target}`)); continue; }
        }
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, f.content, { encoding: "utf-8", mode: f.mode ?? 0o644 });
        if (f.mode) fs.chmodSync(target, f.mode);
        console.log(green(`  ✓ ${target}`));
    }
    fs.mkdirSync(projectsPath, { recursive: true, mode: 0o700 });
    console.log(green(`  ✓ ${projectsPath}/`));

    let started = false;
    if (runner === "systemd") {
        const unit = deployerUnit(answers, dir);
        if (!unit.text) {
            console.error(red(`  ✗ ${unit.problems!.join("; ")}`));
            process.exit(1);
        }
        const same = fs.existsSync(unit.file) && fs.readFileSync(unit.file, "utf-8") === unit.text;
        if (same) console.log(dim(`  = ${unit.file} (unchanged)`));
        else if (!fs.existsSync(unit.file) || await yes(`  ${unit.file} exists — replace it?`, false)) {
            fs.mkdirSync(path.dirname(unit.file), { recursive: true });
            fs.writeFileSync(unit.file, unit.text, { mode: 0o644 });
            console.log(green(`  ✓ ${unit.file}`));
        }
        await realSystemctl(["daemon-reload"]);
        if (await yes(`\nStart the deployer now (and at every boot)?`, true)) {
            try {
                await realSystemctl(["enable", unitName(name)]);
                await realSystemctl(["restart", unitName(name)]);
                started = true;
                console.log(green(`  ✓ started: ${unitName(name)}`));
            } catch (e: any) {
                console.error(red(`  ✗ ${String(e?.stderr || e?.message || e).trim()}`));
            }
        }
        console.log("");
        await Ps(["startup"]);
    }

    // ---- next ----
    console.log(bold("\nNext"));
    if (runner === "systemd")
        console.log(`  1. ${started ? "Running" : "Start it"}:${started ? "           " : "          "}${bold(started ? `bmfk ps show ${name}` : `systemctl --user enable --now ${unitName(name)}`)}${started ? "" : dim("  (then: bmfk ps show " + name + ")")}`);
    else {
        console.log(`  1. Start it:          ${bold("pm2 start ecosystem.config.cjs && pm2 save")}`);
        console.log(`                        ${dim("once per server, to start pm2 at boot: pm2 startup (run the command it prints)")}`);
    }
    console.log(`  2. Check it:          curl -s http://127.0.0.1:${port}${baseEndPoint}liveness`);
    console.log(`  3. nginx (TLS site):\n${nginxSnippet(answers).split("\n").map(l => "       " + l).join("\n")}`);
    console.log(`  4. Each project:      npx bmfk project-config  → put the config into ${projectsPath}`);
    console.log(`     and in its deploy.json: "host": "https://<this server's domain>${baseEndPoint}pckg/add", "username": "${users[0].login}"`);
    console.log("");
}
