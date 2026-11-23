import fs from "fs";
import { projectNameProblem } from "./ConfigService";
import path from "path";
import crypto from "crypto";
import { stdin as input } from "process";
import { PasswordHash } from "../helper/PasswordHash";
import { MonitorAuth } from "../monitor/MonitorAuth";
import { palette } from "./cliCommon";
import { ask, yes, list } from "./cliPrompt";

// One value to replace with its hash: `secret` is what the hash must verify against.
interface IChange { file: string, label: string, apply: (doc: any, hash: string) => void, secret: string, read: (doc: any) => string }
interface IFilePlan { file: string, doc: any, changes: IChange[], notes: string[] }

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * `bmfk migrate-configs` — moves old deployer and access files to hashed secrets, computing
 * every hash from the value already in the file, so nobody retypes anything and clients keep
 * their credentials:
 *   setup.json   users[].password      → scrypt(sha256(login:password))   (what the deployer checks)
 *                users[].username      → users[].login                    (old field name)
 *                reviewers[].password  → scrypt(password)
 *   <project>.json token               → scrypt(token)
 *   access.json  monitor[].password, documentation[].password → scrypt(password)
 * Shows a report first, copies the originals aside, writes atomically, then verifies every hash.
 */
export async function MigrateConfigsWizard(folder?: string, assumeYes = false): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY && !assumeYes) {
        console.error(red("✗ migrate-configs asks for confirmation — run it in a terminal, or add --yes."));
        process.exit(1);
    }

    console.log(bold("\nMove deployer and access files to hashed secrets") + dim(assumeYes ? "  (--yes: no confirmation)" : "  (nothing is written before you confirm)"));
    console.log(yellow("  Run this right after upgrading to 6.x: older versions don't understand hashes, newer ones refuse plain text.\n"));

    let setupFile: string, projectsDir: string, accessFiles: string[];
    if (folder) {
        // One folder: its setup.json (when it is there) and every project config in it.
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
            console.error(red(`✗ ${folder} is not a folder.`));
            process.exit(1);
        }
        projectsDir = folder;
        const inside = path.join(folder, "setup.json");
        if (fs.existsSync(inside)) setupFile = inside;
        else if (assumeYes) { setupFile = ""; console.log(yellow(`  ⚠ No setup.json in ${folder} — deployer users are not converted.`)); }
        else setupFile = await ask(`No setup.json in ${folder}. Deployer setup.json (empty = skip)`, "");
        accessFiles = [];
    } else {
        const defSetup = ["setup.json", "projects/setup.json"].find(f => fs.existsSync(f)) ?? "";
        setupFile = await ask("Deployer setup.json (empty = skip)", defSetup);
        projectsDir = await ask("Folder with project configs (empty = skip)", setupFile ? path.dirname(setupFile) : "");
        accessFiles = list(await ask("access.json files of apps, comma-separated (empty = skip)", ""));
    }

    const plans: IFilePlan[] = [];
    const readJson = (file: string): any => {
        try { return JSON.parse(fs.readFileSync(file, "utf-8")); }
        catch (e: any) { console.log(red(`  ✗ ${file}: ${e?.code === "ENOENT" ? "not found" : "not valid JSON"} — skipped`)); return null; }
    };
    const plain = (v: unknown) => typeof v === "string" && v.length > 0 && !PasswordHash.isHash(v);

    // ---- setup.json ----
    if (setupFile) {
        const doc = readJson(setupFile);
        if (doc) {
            const plan: IFilePlan = { file: path.resolve(setupFile), doc, changes: [], notes: [] };
            (doc.users ?? []).forEach((u: any, i: number) => {
                if (u && u.login === undefined && typeof u.username === "string") {
                    plan.notes.push(`users[${i}]: "username" renamed to "login" (${u.username})`);
                    u.login = u.username; delete u.username;
                }
                if (u && plain(u.password)) {
                    // A hash doesn't make a guessable password safe: say so while we still see it.
                    if (u.password === u.login) plan.notes.push(`deployer user "${u.login}": the password is the same as the login — change it (npx bmfk hash-password --deployer, and the client's deploy.json)`);
                    else if (MonitorAuth.passwordPolicyError(u.password)) plan.notes.push(`deployer user "${u.login}": password shorter than 12 characters — change it (npx bmfk hash-password --deployer, and the client's deploy.json)`);
                    const secret = sha256(u.login + ":" + u.password);
                    plan.changes.push({ file: plan.file, label: `deployer user "${u.login}"`, secret,
                        apply: (d, h) => { d.users[i].password = h; }, read: d => d.users[i].password });
                }
            });
            (doc.reviewers ?? []).forEach((r: any, i: number) => {
                if (r && plain(r.password)) {
                    if (r.password === r.login) plan.notes.push(`reviewer "${r.login}": the password is the same as the login — change it later`);
                    else if (MonitorAuth.passwordPolicyError(r.password)) plan.notes.push(`reviewer "${r.login}": password shorter than 12 characters — change it later`);
                    plan.changes.push({ file: plan.file, label: `reviewer "${r.login}"`, secret: r.password,
                        apply: (d, h) => { d.reviewers[i].password = h; }, read: d => d.reviewers[i].password });
                }
            });
            plans.push(plan);
        }
    }

    // ---- project configs ----
    if (projectsDir) {
        let names: string[] = [];
        try { names = fs.readdirSync(projectsDir).filter(n => n.endsWith(".json")).sort(); }
        catch { console.log(red(`  ✗ ${projectsDir}: not a readable folder — skipped`)); }
        for (const n of names) {
            const file = path.resolve(projectsDir, n);
            if (setupFile && file === path.resolve(setupFile)) continue;
            if (n.endsWith("_state_.json")) continue;   // blue-green state, not a config
            const doc = readJson(file);
            if (!doc || typeof doc !== "object" || typeof doc.name !== "string" || typeof doc.token !== "string") continue;
            const plan: IFilePlan = { file, doc, changes: [], notes: [] };
            const nameProblem = projectNameProblem(doc.name);
            if (nameProblem) plan.notes.push(`${nameProblem} — the deployer ignores this project until it is renamed`);
            if (plain(doc.token)) {
                if (doc.token.length < 32) plan.notes.push(`project "${doc.name}": short token (${doc.token.length} chars) — consider a new one: npx bmfk project-token`);
                plan.changes.push({ file, label: `project token "${doc.name}"`, secret: doc.token,
                    apply: (d, h) => { d.token = h; }, read: d => d.token });
            }
            plans.push(plan);
        }
    }

    // ---- access files ----
    for (const f of accessFiles) {
        const doc = readJson(f);
        if (!doc) continue;
        const plan: IFilePlan = { file: path.resolve(f), doc, changes: [], notes: [] };
        (doc.monitor ?? []).forEach((u: any, i: number) => {
            if (u && plain(u.password)) {
                if (u.password === u.login) plan.notes.push(`monitor user "${u.login}": the password is the same as the login — change it later (npx bmfk access-config)`);
                else if (MonitorAuth.passwordPolicyError(u.password)) plan.notes.push(`monitor user "${u.login}": password shorter than 12 characters — change it later (npx bmfk access-config)`);
                plan.changes.push({ file: plan.file, label: `monitor user "${u.login}"`, secret: u.password,
                    apply: (d, h) => { d.monitor[i].password = h; }, read: d => d.monitor[i].password });
            }
        });
        // Documentation users sign in like monitor users now: their passwords are hashes too.
        (doc.documentation ?? []).forEach((u: any, i: number) => {
            if (u && plain(u.password)) {
                if (u.password === u.login) plan.notes.push(`documentation user "${u.login}": the password is the same as the login — change it later (npx bmfk access-config)`);
                else if (MonitorAuth.passwordPolicyError(u.password)) plan.notes.push(`documentation user "${u.login}": password shorter than 12 characters — change it later (npx bmfk access-config)`);
                plan.changes.push({ file: plan.file, label: `documentation user "${u.login}"`, secret: u.password,
                    apply: (d, h) => { d.documentation[i].password = h; }, read: d => d.documentation[i].password });
            }
        });
        plans.push(plan);
    }

    // ---- report ----
    const todo = plans.filter(p => p.changes.length || p.notes.some(n => n.includes("renamed")));
    console.log("\n" + bold("Report"));
    for (const p of plans) {
        const head = p.changes.length ? yellow(`${p.changes.length} to hash`) : green("already hashed");
        console.log(`  ${p.file}  ${head}`);
        for (const c of p.changes) console.log(dim(`    • ${c.label}`));
        for (const n of p.notes) console.log(yellow(`    ⚠ ${n}`));
    }
    if (!todo.length) { console.log(green("\n✓ Nothing to change.")); return; }
    if (!assumeYes && !(await yes(`\nHash ${todo.reduce((n, p) => n + p.changes.length, 0)} value(s) in ${todo.length} file(s)?`, false))) {
        console.log(dim("Nothing was changed."));
        return;
    }

    // ---- write ----
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.resolve(path.dirname(todo[0].file), `.pre-hash-backup-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (const [i, p] of todo.entries()) {
        const copy = path.join(backupDir, `${i + 1}-${path.basename(p.file)}`);   // two access.json from different apps don't collide
        fs.copyFileSync(p.file, copy);
        fs.chmodSync(copy, 0o600);
    }
    let failed = 0;
    for (const p of todo) {
        for (const c of p.changes) c.apply(p.doc, await PasswordHash.hash(c.secret));
        const tmp = p.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(p.doc, null, 4) + "\n", { encoding: "utf-8", mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, p.file);
        // Read back and check every hash against the value it replaced.
        const back = JSON.parse(fs.readFileSync(p.file, "utf-8"));
        for (const c of p.changes) {
            if (await PasswordHash.verify(c.secret, c.read(back))) continue;
            failed++;
            console.log(red(`  ✗ ${p.file}: ${c.label} did not verify — restore it from ${backupDir}`));
        }
        console.log((failed ? yellow : green)(`  ✓ ${p.file}`) + dim(" (0600)"));
    }

    console.log("");
    if (failed) { console.log(red(`✗ ${failed} value(s) did not verify. The originals are in ${backupDir}.`)); process.exit(1); }
    console.log(green("✓ Done. A running 6.x deployer and apps pick the files up without a restart."));
    console.log(yellow(`  The originals (with the plain secrets) are in ${backupDir}.`));
    console.log(yellow("  Check that deploys and monitor sign-in work, then delete that folder:"));
    console.log(`    rm -rf ${JSON.stringify(backupDir)}`);
}
