import fs from "fs";
import path from "path";
import crypto from "crypto";
import { stdin as input } from "process";
import { PasswordHash } from "../helper/PasswordHash";
import { IpAllowList } from "../helper/IpAllowList";
import { Validator } from "../helper/Validator";
import { MonitorAuth } from "../monitor/MonitorAuth";
import { SETUP_MODEL } from "./DeployerService";
import { askHidden } from "./HashPassword";
import { palette } from "./cliCommon";
import { ask, askValid, yes, list } from "./cliPrompt";

/**
 * `bmfk setup-config [file|folder]` — edits the deployer's setup.json from a menu: deployer users
 * (stored as scrypt(sha256(login:password)), what the deployer checks), reviewers, allowed_ips and
 * review_url. The deployer re-reads the file on change. Nothing is written until "save", and the
 * result is checked against the deployer's own schema.
 */
export async function SetupConfigWizard(target?: string): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ setup-config needs an interactive terminal — it asks for passwords."));
        process.exit(1);
    }

    let file = target ?? (["setup.json", "projects/setup.json"].find(f => fs.existsSync(f)) ?? "");
    if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) file = path.join(target, "setup.json");
    console.log(bold("\nDeployer setup.json") + dim("  (the deployer re-reads it on change)"));
    file = path.resolve(file || await ask("File", "setup.json"));

    let doc: any = { users: [] };
    if (fs.existsSync(file)) {
        try { doc = JSON.parse(fs.readFileSync(file, "utf-8") || "{}"); }
        catch (e: any) { console.error(red(`✗ ${file} is not valid JSON (${e?.message ?? e}).`)); process.exit(1); }
        console.log(dim(`  Loaded ${file}`));
    } else {
        console.log(dim(`  New file: ${file}`));
    }
    doc.users = Array.isArray(doc.users) ? doc.users : [];
    // Old field name: the deployer reads "login" only.
    for (const u of doc.users) if (u && u.login === undefined && typeof u.username === "string") {
        u.login = u.username; delete u.username;
        console.log(yellow(`  ⚠ "${u.login}": old field "username" renamed to "login" — saved with the next save`));
    }
    let changed = false;
    const clientsToUpdate = new Set<string>();

    const show = () => {
        console.log("\n" + bold("Deployer users") + dim("  (in deploy.json: username + password)"));
        if (!doc.users.length) console.log(red("  none — nobody can deploy"));
        for (const u of doc.users) {
            const state = u.publicKey ? green("signing key")
                : !u.password ? red("no password or key — can't sign in")
                : doc.require_signature !== false ? yellow("password — refused, only signed requests are accepted")
                : PasswordHash.isHash(u.password) ? dim("hashed password")
                : red("PLAIN-TEXT password — refused, set a new one or run migrate-configs");
            console.log(`  ${String(u.login).padEnd(20)} ${state}`);
        }
        console.log(bold("Signed requests only") + "  " + (doc.require_signature !== false ? green("yes") : yellow("no — password users still accepted")));
        console.log(bold("Reviewers"));
        if (!doc.reviewers?.length) console.log(dim("  none"));
        for (const r of doc.reviewers ?? [])
            console.log(`  ${String(r.login).padEnd(20)} ${String(r.email ?? "").padEnd(28)} ${PasswordHash.isHash(r.password) ? dim("hashed password") : red("PLAIN-TEXT password")}`);
        console.log(bold("Allowed addresses") + "  " + (doc.allowed_ips?.length ? doc.allowed_ips.join(", ") : dim("any address")));
        console.log(bold("Review page URL") + "    " + (doc.review_url || dim("not set")));
    };

    const user = (login: string) => doc.users.find((u: any) => u.login === login);
    const reviewer = (login: string) => (doc.reviewers ?? []).find((r: any) => r.login === login);

    async function password(question: string): Promise<string> {
        for (;;) {
            const p1 = await askHidden(`  ${question} (hidden, 12+ characters): `);
            const policy = MonitorAuth.passwordPolicyError(p1);
            if (policy) { console.log(red(`  ✗ ${policy}`)); continue; }
            const p2 = await askHidden("  repeat: ");
            if (p1 !== p2) { console.log(red("  ✗ passwords do not match")); continue; }
            return p1;
        }
    }
    // What the deployer compares: the client sends sha256(login:password) — keep that wire format.
    const deployerHash = (login: string, pw: string) => PasswordHash.hash(crypto.createHash("sha256").update(login + ":" + pw).digest("hex"));
    const validLogin = (v: string) => /^[A-Za-z0-9._@-]+$/.test(v) ? null : "letters, digits, '.', '_', '-', '@' only";

    const actions: Record<string, { title: string, run: () => Promise<void> }> = {
        "1": { title: "add a deployer user", run: async () => {
            const login = await askValid("  login", "", v => !v ? "required" : user(v) ? "already exists" : validLogin(v));
            doc.users.push({ login, password: await deployerHash(login, await password(`password for ${login}`)) });
            clientsToUpdate.add(login);
            console.log(green(`  ✓ ${login} added`));
            changed = true;
        }},
        "2": { title: "change a deployer user's password", run: async () => {
            const u = user(await askValid("  login", "", v => user(v) ? null : "no such user"));
            u.password = await deployerHash(u.login, await password(`new password for ${u.login}`));
            clientsToUpdate.add(u.login);
            console.log(green(`  ✓ password of ${u.login} changed`));
            changed = true;
        }},
        "3": { title: "rename a deployer user", run: async () => {
            const u = user(await askValid("  current login", "", v => user(v) ? null : "no such user"));
            const login = await askValid("  new login", "", v => !v ? "required" : user(v) ? "already exists" : validLogin(v));
            // The stored hash covers login:password, so the password is needed again.
            u.password = await deployerHash(login, await password(`password for ${login} (the same or a new one)`));
            clientsToUpdate.delete(u.login);
            u.login = login;
            clientsToUpdate.add(login);
            console.log(green(`  ✓ renamed to ${login}`));
            changed = true;
        }},
        "4": { title: "remove a deployer user", run: async () => {
            const login = await askValid("  login", "", v => user(v) ? null : "no such user");
            if (doc.users.length === 1) console.log(yellow("  ⚠ This is the last user — nobody will be able to deploy."));
            if (!(await yes(`  remove ${login}?`, false))) return;
            doc.users = doc.users.filter((u: any) => u.login !== login);
            clientsToUpdate.delete(login);
            console.log(green(`  ✓ ${login} removed`));
            changed = true;
        }},
        "k": { title: "set a deployer user's public key (signed deploys)", run: async () => {
            const u = user(await askValid("  login", "", v => user(v) ? null : "no such user — add the user first"));
            const key = await askValid("  public key from `npx bmfk deploy-key` (base64)", "", v => {
                try { crypto.createPublicKey({ key: Buffer.from(v, "base64"), format: "der", type: "spki" }); return /^MCowBQYDK2VwAyEA/.test(v) ? null : "not an Ed25519 public key"; }
                catch { return "not a public key (base64 SPKI)"; }
            });
            u.publicKey = key;
            // A user with a key is only accepted signed; a leftover password hash just sits there.
            if (u.password) { delete u.password; console.log(dim("  password removed — the user signs in with the key only")); }
            clientsToUpdate.delete(u.login);
            console.log(green(`  ✓ ${u.login} signs requests with their key`));
            changed = true;
        }},
        "r": { title: "require signed requests from everyone (on/off)", run: async () => {
            const passwordUsers = doc.users.filter((x: any) => !x.publicKey).map((x: any) => x.login);
            const on = doc.require_signature !== false;
            if (!on && passwordUsers.length)
                console.log(yellow(`  ⚠ ${passwordUsers.join(", ")} have no key yet — they can't deploy once this is on.`));
            if (await yes("  only signed requests?", !on)) delete doc.require_signature;
            else doc.require_signature = false;
            changed = true;
        }},
        "5": { title: "add a reviewer", run: async () => {
            const login = await askValid("  login", "", v => !v ? "required" : reviewer(v) ? "already exists" : validLogin(v));
            const email = await askValid("  email (gets the review links)", "", v => /^[^\s@]+@[^\s@]+$/.test(v) ? null : "an email address");
            doc.reviewers = [...(doc.reviewers ?? []), { login, password: await PasswordHash.hash(await password(`password for ${login}`)), email }];
            console.log(green(`  ✓ reviewer ${login} added`) + dim(" — 2FA is set up at the first sign-in on the review page"));
            changed = true;
        }},
        "6": { title: "change a reviewer's password or email", run: async () => {
            const r = reviewer(await askValid("  login", "", v => reviewer(v) ? null : "no such reviewer"));
            r.email = await askValid("  email", r.email ?? "", v => /^[^\s@]+@[^\s@]+$/.test(v) ? null : "an email address");
            if (await yes("  set a new password?", false)) r.password = await PasswordHash.hash(await password(`new password for ${r.login}`));
            console.log(green(`  ✓ ${r.login} updated`));
            changed = true;
        }},
        "7": { title: "remove a reviewer", run: async () => {
            const login = await askValid("  login", "", v => reviewer(v) ? null : "no such reviewer");
            if (!(await yes(`  remove ${login}? Projects that list them can't be uploaded until their config is changed`, false))) return;
            doc.reviewers = doc.reviewers.filter((r: any) => r.login !== login);
            if (!doc.reviewers.length) delete doc.reviewers;
            console.log(green(`  ✓ ${login} removed`));
            changed = true;
        }},
        "8": { title: "set allowed addresses", run: async () => {
            const v = await askValid("  IPs and subnets, comma-separated (empty = any address)", (doc.allowed_ips ?? []).join(", "),
                x => IpAllowList.build(list(x)).error ?? null);
            const ips = list(v);
            if (ips.length) doc.allowed_ips = ips; else delete doc.allowed_ips;
            if (ips.includes("127.0.0.1") || ips.includes("::1"))
                console.log(yellow("  ⚠ Behind a proxy on this host, loopback lets every request through — use the clients' real addresses."));
            changed = true;
        }},
        "9": { title: "set the review page URL", run: async () => {
            const v = await askValid("  URL (empty = none)", doc.review_url ?? "", x => !x || /^https?:\/\/\S+$/.test(x) ? null : "an http(s) URL");
            if (v) doc.review_url = v; else delete doc.review_url;
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
            const errors = await Validator.validateStructure(SETUP_MODEL, doc);
            if (errors && errors.length) { console.log(red(`  ✗ Not saved — the deployer would refuse it: ${errors.join("; ")}`)); continue; }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = file + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(doc, null, 4) + "\n", { encoding: "utf-8", mode: 0o600 });
            fs.chmodSync(tmp, 0o600);
            fs.renameSync(tmp, file);
            console.log(green(`✓ Saved ${file}`) + dim(" (0600) — a running deployer picks it up within a second"));
            if (clientsToUpdate.size)
                console.log(yellow(`  Update deploy.json wherever these users deploy from (username + password): ${[...clientsToUpdate].join(", ")}`));
            return;
        }
        const action = actions[choice];
        if (!action) { console.log(red("  ✗ choose a number, s or q")); continue; }
        await action.run();
    }
}
