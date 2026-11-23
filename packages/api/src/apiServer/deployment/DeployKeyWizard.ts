import fs from "fs";
import path from "path";
import { stdin as input } from "process";
import { InterceptorSignedAuth } from "../interceptors/InterceptorSignedAuth";
import { palette } from "./cliCommon";
import { ask, askValid, yes } from "./cliPrompt";

/**
 * `bmfk deploy-key [deploy.json]` — a signing key pair for a deployer user. The private key goes
 * into the project's deploy.json (replacing the password); the public key is printed for the
 * deployer's setup.json (`bmfk setup-config` → "set a deployer user's public key").
 */
export async function DeployKeyWizard(target?: string): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ deploy-key needs an interactive terminal — its output is a secret."));
        process.exit(1);
    }
    console.log(bold("\nSigning key for deploys") + dim("  (Ed25519: the deployer keeps only the public key)"));

    // deploy.json to update: the argument, else deploy.json / deploy/*.json in this folder.
    const candidates = target ? [target] : [
        ...(fs.existsSync("deploy.json") ? ["deploy.json"] : []),
        ...(fs.existsSync("deploy") && fs.statSync("deploy").isDirectory()
            ? fs.readdirSync("deploy").filter(f => f.endsWith(".json")).map(f => path.join("deploy", f)) : []),
    ];
    let file = "";
    if (candidates.length === 1) file = await ask("deploy.json to put the private key into (empty = only print it)", candidates[0]);
    else if (candidates.length > 1) {
        candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
        const pick = await askValid("deploy.json (number, path, or empty = only print)", "1", v => !v || !/^\d+$/.test(v) || candidates[+v - 1] ? null : "no such number");
        file = /^\d+$/.test(pick) ? candidates[+pick - 1] : pick;
    } else file = await ask("deploy.json to put the private key into (empty = only print it)", "");

    let cfg: any = null;
    if (file) {
        try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")); }
        catch (e: any) { console.error(red(`✗ ${file}: ${e?.code === "ENOENT" ? "not found" : "not valid JSON"}`)); process.exit(1); }
        if (cfg.privateKey && !(await yes(`${file} already has a privateKey — replace it?`, false))) return;
    }
    const login = await askValid("Deployer user login", cfg?.username ?? "", v => /^[A-Za-z0-9._@-]+$/.test(v) ? null : "letters, digits, '.', '_', '-', '@' only");

    const { publicKey, privateKey } = InterceptorSignedAuth.generateKeyPair();

    if (cfg) {
        cfg.username = login;
        cfg.privateKey = privateKey;
        // With a key the deployer refuses the password, and a password left in the file is just a leak.
        const hadPassword = "password" in cfg;
        delete cfg.password;
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 4) + "\n", { encoding: "utf-8", mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
        console.log(green(`\n✓ ${path.resolve(file)}`) + dim(` — privateKey written${hadPassword ? ", password removed" : ""} (0600)`));
        console.log(yellow("  This file can deploy on its own: never commit or share it. In CI keep it in a secret."));
    } else {
        console.log(`\nPrivate key — put it into deploy.json as "privateKey" (and keep that file out of git):\n\n  ${bold(privateKey)}\n`);
    }

    console.log(`\nPublic key of ${bold(login)} — for the deployer's setup.json:\n\n  ${bold(publicKey)}\n`);
    console.log(dim("  On the deployer: npx bmfk setup-config → \"set a deployer user's public key\""));
    console.log(dim(`  or by hand: { "login": "${login}", "publicKey": "${publicKey}" }`));
    console.log(dim("  Until the deployer has this public key, this deploy.json can't deploy."));
}

/**
 * `bmfk ms-key` — a signing key pair for signed microservice calls. One per caller (its public
 * key goes into the host's "clients") and one per host (its public key is every caller's
 * "hostPublicKey"). Only printed: where the private key lives (secrets, config) is the project's call.
 */
export function MicroserviceKey(): void {
    const { red, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ ms-key needs an interactive terminal — its output is a secret."));
        process.exit(1);
    }
    const { publicKey, privateKey } = InterceptorSignedAuth.generateKeyPair();
    console.log(bold("\nMicroservice signing key") + dim("  (Ed25519)"));
    console.log(`\nPrivate key — "privateKey" of this service (host or caller). A secret: keep it out of git.\n\n  ${bold(privateKey)}\n`);
    console.log(`Public key — not a secret:`);
    console.log(dim(`  a caller's → the host's  clients: { "<kid>": { publicKey: "…" } }`));
    console.log(dim(`  a host's   → each caller's  hostPublicKey`));
    console.log(`\n  ${bold(publicKey)}\n`);
    console.log(yellow("A new pair for every service — never reuse one key on two services."));
}
