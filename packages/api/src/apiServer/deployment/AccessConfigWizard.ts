import fs from "fs";
import path from "path";
import { AppData } from "../helper/AppDataPath";
import crypto from "crypto";
import { stdin as input } from "process";
import { PasswordHash } from "../helper/PasswordHash";
import { IpAllowList } from "../helper/IpAllowList";
import { MonitorAuth } from "../monitor/MonitorAuth";
import { AccessStore } from "../monitor/AccessStore";
import { askHidden } from "./HashPassword";
import { palette } from "./cliCommon";
import { ask, askValid, yes, list } from "./cliPrompt";

const ROLES: Record<string, string> = {
    admin: "everything, incl. restart, log level and IP blocking",
    it: "dashboard and logs",
    analytic: "dashboard only",
};

/**
 * `bmfk access-config` — creates or edits the access file the service reads live
 * (APIService option `access: "/path/to/access.json"`): monitor users (password stored as a hash,
 * a role), documentation users and the monitor's address allow-list. Nothing is written until
 * "save", and the result is checked with the same validator the service uses.
 */
// Where the project points `access` at a file: a string literal ending in .json assigned to
// `access` (`opts.access = "/var/monitor/access.shop.json"` or `access: "…"`). Looks in src/ for a
// developer machine and in bin/ or dist/ for a server that only has the compiled code.
export function findAccessPaths(root: string): { path: string, where: string }[] {
    const found: { path: string, where: string }[] = [];
    const re = /\baccess\s*[:=]\s*(["'`])([^"'`\n]+?\.json)\1/g;
    let files = 0;
    const visit = (dir: string, depth: number) => {
        if (depth > 8 || files > 3000) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === "node_modules" || e.name.startsWith(".")) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { visit(abs, depth + 1); continue; }
            if (!e.isFile() || !/\.(ts|js|cjs|mjs)$/.test(e.name) || e.name.endsWith(".d.ts")) continue;
            files++;
            let text: string;
            try { if (fs.statSync(abs).size > 1024 * 1024) continue; text = fs.readFileSync(abs, "utf-8"); } catch { continue; }
            for (const m of text.matchAll(re)) {
                if (found.some(f => f.path === m[2])) continue;
                const line = text.slice(0, m.index).split("\n").length;
                found.push({ path: m[2], where: `${path.relative(root, abs)}:${line}` });
            }
        }
    };
    for (const sub of ["src", "bin", "dist"]) {
        const dir = path.join(root, sub);
        if (fs.existsSync(dir)) visit(dir, 0);
    }
    return found;
}

export async function AccessConfigWizard(fileArg?: string): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ access-config needs an interactive terminal — it asks for passwords."));
        process.exit(1);
    }

    console.log(bold("\nAccess file for the monitor and the documentation") + dim("  (the service re-reads it on change)"));
    let file: string;
    if (fileArg) {
        file = path.resolve(fileArg);
    } else {
        // The project in the current folder usually names its file in the code (options.access).
        const found = findAccessPaths(process.cwd());
        if (found.length === 1) {
            console.log(dim(`  This project's access file (from ${found[0].where}): ${found[0].path}`));
            file = path.resolve(await ask("File", found[0].path));
        } else if (found.length > 1) {
            found.forEach((f, i) => console.log(`  ${i + 1}) ${f.path} ${dim("— " + f.where)}`));
            const pick = await askValid("File (number or path)", "1", v => /^\d+$/.test(v) && !found[+v - 1] ? "no such number" : null);
            file = path.resolve(/^\d+$/.test(pick) ? found[+pick - 1].path : pick);
        } else {
            // No path in the code: the service reads the data folder's access.json (option access: "").
            const fallback = path.join(AppData.projectDir(AppData.project()), "access.json");
            console.log(dim(`  This project reads ${fallback} unless its code sets "access" to another file.`));
            file = path.resolve(await ask("File", fallback));
        }
    }

    let doc: any = { monitor: [], documentation: [] };
    if (fs.existsSync(file)) {
        try {
            doc = JSON.parse(fs.readFileSync(file, "utf-8") || "{}");
        } catch (e: any) {
            console.error(red(`✗ ${file} is not valid JSON (${e?.message ?? e}) — fix it first or choose another file.`));
            process.exit(1);
        }
        const problem = AccessStore.validate(doc);
        if (problem) console.log(yellow(`  ⚠ The file has a problem the service would refuse: ${problem}. Fix it here before saving.`));
        console.log(dim(`  Loaded ${file}`));
    } else {
        console.log(dim(`  New file: ${file}`));
    }
    doc.monitor = Array.isArray(doc.monitor) ? doc.monitor : [];
    doc.documentation = Array.isArray(doc.documentation) ? doc.documentation : [];
    let changed = false;

    const show = () => {
        console.log("\n" + bold("Monitor users"));
        if (!doc.monitor.length) console.log(dim("  none — nobody can open the monitor"));
        for (const u of doc.monitor) {
            const state = PasswordHash.isHash(u.password) ? dim("hashed password") : red("PLAIN-TEXT password — refused at sign-in, change it");
            console.log(`  ${u.login.padEnd(20)} ${String(u.role ?? "admin (default)").padEnd(16)} ${state}`);
        }
        console.log(bold("Documentation users"));
        if (!doc.documentation.length) console.log(dim("  none"));
        for (const u of doc.documentation)
            console.log(`  ${u.login.padEnd(20)} ${u.endpoints?.length ? "endpoints: " + u.endpoints.join(", ") : dim("all endpoints")}`);
        console.log(bold("Monitor allowed addresses"));
        console.log("  " + (doc.monitorAllowedIps?.length ? doc.monitorAllowedIps.join(", ") : dim("any address")));
    };

    const monitorLogin = (login: string) => doc.monitor.find((u: any) => u.login === login);
    const docLogin = (login: string) => doc.documentation.find((u: any) => u.login === login);

    async function newMonitorPassword(login: string): Promise<string> {
        for (;;) {
            const p1 = await askHidden(`  password for ${login} (hidden, 12+ characters): `);
            const policy = MonitorAuth.passwordPolicyError(p1);
            if (policy) { console.log(red(`  ✗ ${policy}`)); continue; }
            const p2 = await askHidden("  repeat: ");
            if (p1 !== p2) { console.log(red("  ✗ passwords do not match")); continue; }
            return PasswordHash.hash(p1);
        }
    }
    const askRole = (def: string) => askValid(`  role: ${Object.keys(ROLES).map(r => `${r} (${ROLES[r]})`).join(" / ")}\n  role`, def,
        v => v in ROLES ? null : "admin, it or analytic");

    const actions: Record<string, { title: string, run: () => Promise<void> }> = {
        "1": { title: "add a monitor user", run: async () => {
            const login = await askValid("  login", "", v => !v ? "required" : v.includes(":") ? "no ':' in logins" : monitorLogin(v) ? "already exists — use 'change password' or 'change role'" : null);
            const role = await askRole("it");
            doc.monitor.push({ login, password: await newMonitorPassword(login), role });
            console.log(green(`  ✓ ${login} added`) + dim(" — 2FA is set up at the first sign-in"));
            changed = true;
        }},
        "2": { title: "change a monitor password", run: async () => {
            const u = monitorLogin(await askValid("  login", "", v => monitorLogin(v) ? null : "no such monitor user"));
            u.password = await newMonitorPassword(u.login);
            console.log(green(`  ✓ password of ${u.login} changed`) + dim(" — their open sessions end when the service picks up the file"));
            changed = true;
        }},
        "3": { title: "change a monitor role", run: async () => {
            const u = monitorLogin(await askValid("  login", "", v => monitorLogin(v) ? null : "no such monitor user"));
            u.role = await askRole(u.role ?? "admin");
            console.log(green(`  ✓ ${u.login} is now ${u.role}`));
            changed = true;
        }},
        "4": { title: "remove a monitor user", run: async () => {
            const login = await askValid("  login", "", v => monitorLogin(v) ? null : "no such monitor user");
            if (!(await yes(`  remove ${login}?`, false))) return;
            doc.monitor = doc.monitor.filter((u: any) => u.login !== login);
            console.log(green(`  ✓ ${login} removed`) + dim(" — their sessions end when the service picks up the file"));
            changed = true;
        }},
        "5": { title: "add a documentation user", run: async () => {
            const login = await askValid("  login", "", v => !v ? "required" : v.includes(":") ? "no ':' in logins" : docLogin(v) ? "already exists" : null);
            let password: string;
            if (await yes("  generate a random password?", true)) {
                const plain = crypto.randomBytes(18).toString("base64url");
                console.log(`  password: ${bold(plain)} ${dim("— pass it on now; only its hash is stored")}`);
                password = await PasswordHash.hash(plain);
            } else {
                password = await newMonitorPassword(login);
            }
            const endpoints = list(await ask("  limit to endpoints, comma-separated (empty = all)", ""));
            doc.documentation.push({ login, password, ...(endpoints.length ? { endpoints } : {}) });
            console.log(green(`  ✓ ${login} added`) + dim(" — 2FA is set up at the first sign-in"));
            changed = true;
        }},
        "6": { title: "remove a documentation user", run: async () => {
            const login = await askValid("  login", "", v => docLogin(v) ? null : "no such documentation user");
            if (!(await yes(`  remove ${login}?`, false))) return;
            doc.documentation = doc.documentation.filter((u: any) => u.login !== login);
            console.log(green(`  ✓ ${login} removed`));
            changed = true;
        }},
        "7": { title: "set the monitor's allowed addresses", run: async () => {
            const v = await askValid("  IPs and subnets, comma-separated (empty = any address)", (doc.monitorAllowedIps ?? []).join(", "),
                x => IpAllowList.build(list(x)).error ?? null);
            const ips = list(v);
            if (ips.length) doc.monitorAllowedIps = ips; else delete doc.monitorAllowedIps;
            if (ips.length) console.log(dim("  Behind nginx the service must see the real address (X-Real-IP), or every request looks like 127.0.0.1."));
            changed = true;
        }},
    };

    for (;;) {
        show();
        console.log("\n" + Object.entries(actions).map(([k, a]) => `  ${k}) ${a.title}`).join("\n") + `\n  s) save and exit\n  q) quit without saving`);
        const choice = (await ask("Choose", "")).toLowerCase();
        if (choice === "q") {
            if (changed && !(await yes("Discard the changes?", false))) continue;
            return;
        }
        if (choice === "s") {
            const problem = AccessStore.validate(doc);
            if (problem) { console.log(red(`  ✗ Not saved — the service would refuse it: ${problem}`)); continue; }
            if (!doc.monitor.some((u: any) => PasswordHash.isHash(u.password)))
                console.log(yellow("  ⚠ No monitor user can sign in — the monitor stays closed."));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = file + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
            fs.chmodSync(tmp, 0o600);
            fs.renameSync(tmp, file);
            console.log(green(`✓ Saved ${file}`) + dim(" (0600) — a running service picks it up within a second"));
            console.log(dim(`  Point the service at it: access: ${JSON.stringify(file)}`));
            return;
        }
        const action = actions[choice];
        if (!action) { console.log(red("  ✗ choose a number, s or q")); continue; }
        await action.run();
    }
}
