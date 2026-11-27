import fs from "fs";
import path from "path";
import crypto from "crypto";
import { stdin as input } from "process";
import { PasswordHash } from "../helper/PasswordHash";
import { Validator } from "../helper/Validator";
import { PROJECT_CONFIG_MODEL, projectNameProblem } from "./ConfigService";
import { askHidden } from "./HashPassword";
import { palette } from "./cliCommon";
import { ask, askValid, yes, list, tokens } from "./cliPrompt";
import { findDeployer } from "./DeployerInit";

/**
 * `bmfk project-config` — asks for a project's deploy settings and produces:
 *   - the project config for the deployer (<projects_path>/<name>.json), token stored as a hash;
 *   - a deploy.json skeleton for the project itself, with the token in plain text (shown once).
 * Config values are typed hidden. Interactive only: the output holds secrets.
 */
export async function ProjectConfigWizard(): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ project-config needs an interactive terminal — it asks for secrets."));
        process.exit(1);
    }

    const section = (title: string) => console.log("\n" + bold(title));

    console.log(bold("\nNew project config for the deployer") + dim("  (Enter keeps the value in brackets)"));
    const deployer = findDeployer(process.cwd());
    if (deployer) console.log(dim(`  Deployer: project configs in ${deployer.projectsPath}, setup.json in ${deployer.setupPath}`));
    else console.log(yellow("  No deployer found here (bin/Main.js from deployer-init) — run this in the deployer's folder, or copy the result there."));
    const setupFile = deployer ? path.join(deployer.setupPath, "setup.json") : null;
    let setupDoc: any = null;
    if (setupFile && fs.existsSync(setupFile)) {
        try { setupDoc = JSON.parse(fs.readFileSync(setupFile, "utf-8") || "{}"); }
        catch { console.log(yellow(`  ⚠ ${setupFile} is not valid JSON — fix it with npx bmfk setup-config`)); }
    }
    let reviewUrl: string | null = null;

    section("Project");
    const name = await askValid("Name (e.g. api.gateway.example.com)", "", v => projectNameProblem(v));
    const description = await ask("Description", name);
    const destination = await askValid("Destination folder on the server", `/var/node/${name}`,
        v => !path.isAbsolute(v) ? "must be an absolute path" : /^\/(var|etc|home|usr|opt|srv|tmp|root)?\/?$/.test(v) ? "pick a folder of its own, not a system folder" : null);

    section("Project token");
    let plainToken: string | null = null;
    let tokenHash: string;
    if (await yes("Generate a new random token?", true)) {
        plainToken = crypto.randomBytes(32).toString("hex");
        tokenHash = await PasswordHash.hash(plainToken);
    } else {
        const existing = (await askHidden("Existing token (hidden): ")).trim();
        if (!existing) { console.error(red("✗ A token is required.")); process.exit(1); }
        if (existing.length < 32) console.log(yellow(`  ⚠ Short token (${existing.length} chars) — a generated one is safer.`));
        tokenHash = await PasswordHash.hash(existing);
    }

    section("Deploy steps");
    const unpack = await yes("Unpack the uploaded archive", true);
    const install = unpack ? await yes("Install dependencies (npm ci)", true) : false;
    const omitDev = install ? await yes("Skip devDependencies on the server (npm ci --omit=dev)", false) : false;
    const ignoreDirectoryClean = unpack ? !(await yes("Clean the destination before unpacking", true)) : false;
    const backup = await yes("Back up the current version before each deploy", true);
    const migrate = await yes("Run `npm run migrate` before starting", false);
    const pm2 = await yes("Run the app with pm2", true);
    const pm2Attributes = pm2 ? tokens(await ask(`pm2 flags (quote values with spaces: --cron-restart "10 0 * * *")`, "")) : [];
    const chmodRaw = await askValid("chmod for deployed files (empty = leave as unpacked)", "", v => !v || /^[0-7]{3,4}$/.test(v) ? null : "octal like 750");
    const chmod = chmodRaw ? Number(chmodRaw) : 0;
    if (chmodRaw && Number(chmodRaw.slice(-1)) & 4) console.log(yellow(`  ⚠ ${chmodRaw} lets every user on the server read the files.`));

    section("Notifications");
    const email = list(await ask("Emails, comma-separated", ""));
    const phone = list(await ask("Phones for SMS, comma-separated", ""));
    const liveness = await askValid("Liveness URL checked after deploy (empty = none)", "", v => !v || /^https?:\/\/\S+$/.test(v) ? null : "must be an http(s) URL");

    section("Config values — replace _{{key}}_ in the shipped files");
    console.log(dim("  Values are typed hidden. Empty key finishes."));
    const config: Record<string, string> = {};
    for (;;) {
        const key = await askValid("  key", "", v => !v || /^[A-Za-z0-9_]+$/.test(v) ? (v && v in config ? `"${v}" is already set` : null) : "letters, digits and '_' only");
        if (!key) break;
        config[key] = await askHidden(`  value of ${key} (hidden): `);
    }

    const cfg: Record<string, any> = {
        name, destination, description, token: tokenHash,
        unpack, ignoreDirectoryClean, backup, install, migrate, pm2,
        ...(omitDev ? { omitDev } : {}),
        ...(pm2Attributes.length ? { pm2_attributes: pm2Attributes } : {}),
        ...(chmod ? { chmod } : {}),
        ...(email.length ? { email } : {}),
        ...(phone.length ? { phone } : {}),
        ...(liveness ? { liveness } : {}),
        config,
    };

    section("Blue-green");
    if (await yes("Deploy as two slots (blue/green) with zero-downtime switching?", false)) {
        const bluePort = await askValid("  blue slot port", "", v => /^\d{2,5}$/.test(v) ? null : "a port number");
        const greenPort = await askValid("  green slot port", "", v => !/^\d{2,5}$/.test(v) ? "a port number" : v === bluePort ? "must differ from the blue port" : null);
        const onSwitch = tokens(await ask("  command after each switch", "/usr/sbin/nginx -s reload"));
        if (onSwitch.length && !path.isAbsolute(onSwitch[0])) console.log(yellow("  ⚠ Use an absolute path to the binary — the deployer runs it without a shell."));
        cfg.bluegreen = { blue_config: { port: bluePort }, green_config: { port: greenPort }, ...(onSwitch.length ? { on_switch: onSwitch } : {}) };
    }

    section("nginx");
    if (await yes("Let the deployer manage the nginx config of this project?", !!cfg.bluegreen)) {
        const config_dir = await askValid("  nginx config folder (nginx includes <folder>/*.conf)", "/etc/nginx/node-projects", v => path.isAbsolute(v) ? null : "must be an absolute path");
        const domain = await ask("  domain", "");
        cfg.nginx = { config_dir, ...(domain ? { domain } : {}) };
    }

    section("Secrets file — keeps config values out of the deployed code");
    if (Object.keys(config).length && await yes("Store config values in a secrets file outside the deploy folder?", true)) {
        const where = await ask("  folder (empty = secrets_dir from the deployer's setup.json, else /var/bmfk/<project>)", "");
        if (where && (!path.isAbsolute(where) || path.resolve(where).startsWith(path.resolve(destination) + path.sep)))
            console.log(yellow("  ⚠ The folder must be absolute and outside the deploy folder — the deployer will refuse this project as is."));
        cfg.secrets = where ? { dir: where } : {};
        if (pm2Attributes.some(a => /^--(uid|gid|user)(=|$)/.test(a)))
            console.log(yellow("  ⚠ The pm2 flags switch the user — the app couldn't read the secrets file; the deployer will refuse this project."));
    }

    section("Review — deploys wait for approval");
    if (await yes("Require reviewers to approve each deploy?", false)) {
        const reviewers = list(await askValid("  reviewer logins from the deployer's setup.json, comma-separated", "", v => list(v).length ? null : "at least one login"));
        const mode = (await askValid("  approval: any (one accept) / all (everyone)", "any", v => v === "any" || v === "all" ? null : "any or all"));
        const ttlHours = Number(await askValid("  hours to decide", "24", v => /^\d+$/.test(v) && +v >= 1 && +v <= 168 ? null : "1–168"));
        cfg.review = { reviewers, mode, ttlHours };
        if (setupDoc) {
            const known = new Set((Array.isArray(setupDoc.reviewers) ? setupDoc.reviewers : []).map((r: any) => r?.login));
            const unknown = reviewers.filter(r => !known.has(r));
            if (unknown.length) console.log(yellow(`  ⚠ Not reviewers in ${setupFile}: ${unknown.join(", ")} — add them with npx bmfk setup-config`));
            if (!/^https?:\/\/[^\s#]+$/.test(String(setupDoc.review_url ?? ""))) {
                console.log(dim(`  The review page is <deployer address>${deployer!.baseEndPoint}review/html, as reviewers open it.`));
                reviewUrl = await askValid("  review_url for setup.json (empty = set it later)", "",
                    v => !v || /^https?:\/\/[^\s#]+$/.test(v) ? null : "an http(s) URL without #") || null;
            }
            if (!setupDoc.notifier?.URL || !setupDoc.notifier?.KEY)
                console.log(yellow("  ⚠ No notifier in setup.json: reviewers can't be emailed their links — npx bmfk setup-config."));
            console.log(yellow("  Until reviewers, review_url and the notifier are in setup.json, the deployer refuses this project's uploads."));
        } else {
            console.log(yellow("  ⚠ The deployer's setup.json must also have these reviewers, review_url (the review page, e.g.\n" +
                "    https://deployer.example.com/api/review/html) and a notifier for the emails — npx bmfk setup-config.\n" +
                "    Until then the deployer refuses this project's uploads."));
        }
    }

    // The same schema the deployer uses.
    const errors = await Validator.validateStructure(PROJECT_CONFIG_MODEL, cfg);
    if (errors && errors.length) {
        console.error(red("\n✗ The config doesn't pass the deployer's validation:"));
        for (const e of errors) console.error("  " + e);
        process.exit(1);
    }

    section("Deploy client (deploy.json for the project)");
    const host = await ask("  deployer upload URL", `https://deployer.example.com${deployer?.baseEndPoint ?? "/api/"}pckg/add`);
    const username = await ask("  deployer user login", "");

    const projectJson = JSON.stringify(cfg, null, 4);
    // No credentials: `bmfk deploy-key` adds the signing key (only signed requests are accepted by default).
    const deployJson = JSON.stringify({ name, host, token: plainToken ?? "<the existing token>", username }, null, 4);

    console.log("");
    const save = async (what: string, content: string, def: string): Promise<string | null> => {
        const target = await ask(`Save ${what} to (empty = print here)`, def);
        if (!target) { console.log("\n" + content + "\n"); return null; }
        if (fs.existsSync(target) && !(await yes(`  ${target} exists — overwrite?`, false))) { console.log("\n" + content + "\n"); return null; }
        fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, content + "\n", { encoding: "utf-8", mode: 0o600 });
        console.log(green(`  ✓ ${path.resolve(target)}`) + dim(" (0600)"));
        return path.resolve(target);
    };
    const saved = await save("the project config for the deployer", projectJson,
        deployer ? path.join(deployer.projectsPath, `${name}.json`) : `${name}.json`);
    if (!saved || !deployer || path.dirname(saved) !== path.resolve(deployer.projectsPath))
        console.log(dim(`  → copy it to <projects_path>/${name}.json on the deployer; it is picked up without a restart.`));
    if (reviewUrl && setupFile) {
        const tmp = setupFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ ...setupDoc, review_url: reviewUrl }, null, 4) + "\n", { encoding: "utf-8", mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, setupFile);
        console.log(green(`  ✓ review_url set in ${setupFile}`));
    }
    await save("deploy.json for the project", deployJson, "");
    if (plainToken) console.log(yellow("  The token is shown only here and in deploy.json — the deployer keeps its hash. Keep deploy.json out of git."));
    console.log(dim("  Then, on the machine you deploy from: npx bmfk deploy-key deploy.json — and add the printed public key to setup.json."));
    if (cfg.review) console.log(dim("  Reviewers must exist in the deployer's setup.json; it says at startup if anything is missing."));
}
