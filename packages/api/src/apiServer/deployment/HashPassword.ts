import crypto from "crypto";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { PasswordHash } from "../helper/PasswordHash";
import { MonitorAuth } from "../monitor/MonitorAuth";
import { palette } from "./cliCommon";

// Read a line with the terminal in raw mode and nothing echoed. Done by hand on purpose: muting
// readline's output relies on its internals, which differ between Node versions — in Node 21 the
// old trick silently stopped working and the password showed on screen. No readline interface may
// be open meanwhile, or it would echo the keystrokes itself.
export function askHidden(question: string): Promise<string> {
    return new Promise(resolve => {
        // Echo goes off BEFORE the prompt appears: input that arrives right after it (a paste,
        // a script) would otherwise be echoed by the terminal while it is still in cooked mode.
        const wasRaw = !!input.isRaw;
        input.setRawMode(true);
        output.write(question);
        input.setEncoding("utf8");
        input.resume();
        let value = "";
        const finish = () => {
            input.removeListener("data", onData);
            input.setRawMode(wasRaw);
            input.pause();
            output.write("\n");
        };
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n" || ch === "\u0004") { finish(); resolve(value); return; }
                if (ch === "\u0003") { finish(); process.exit(130); }                 // Ctrl-C
                if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; } // Backspace
                if (ch >= " ") value += ch;
            }
        };
        input.on("data", onData);
    });
}

/**
 * Produces a salted scrypt hash to put in a config instead of a plain password.
 *   monitor  (default) → access.monitor[].password, checked against the password typed at login
 *   deployer           → setup.json users[].password, checked against the CLI's Bearer value,
 *                        i.e. scrypt(sha256(login:password)) — the wire protocol stays the same
 * Interactive only: a password passed as an argument would end up in shell history and `ps`.
 */
export async function HashPassword(target: "monitor" | "deployer"): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ hash-password needs an interactive terminal — the password is never accepted as an argument."));
        process.exit(1);
    }

    console.log(bold(`\nHash a ${target} password`) + dim(target === "deployer" ? "  (setup.json users)" : "  (APIService access.monitor)"));
    // The login is fine to echo; the interface is closed before any password prompt.
    const rl = createInterface({ input, output });
    let login: string;
    try { login = (await rl.question("Login: ")).trim(); }
    finally { rl.close(); }
    if (!login) { console.error(red("✗ Login is required.")); process.exit(1); }

    {
        const pass1 = await askHidden("Password: ");
        const policy = MonitorAuth.passwordPolicyError(pass1);
        if (policy) { console.error(red(`✗ ${policy}.`)); process.exit(1); }
        const pass2 = await askHidden("Repeat password: ");
        if (pass1 !== pass2) { console.error(red("✗ Passwords do not match.")); process.exit(1); }

        const secret = target === "deployer"
            ? crypto.createHash("sha256").update(login + ":" + pass1).digest("hex")
            : pass1;
        const hash = await PasswordHash.hash(secret);

        console.log("");
        console.log(green(bold("✓ Put this in the config instead of the plain password:")));
        console.log(`\n  { "login": ${JSON.stringify(login)}, "password": ${JSON.stringify(hash)} }\n`);
        if (target === "deployer")
            console.log(yellow("  Deployer users stored as a hash need an up-to-date bmfk CLI on the deploying machine."));
        console.log(dim("  The hash is salted — running this again for the same password gives a different, equally valid hash."));
    }
}

/**
 * `bmfk project-token` — the deploy token of one project on the deployer.
 *   (default) → generates a new random token and prints both halves:
 *               the token itself for the project's deploy.json, its hash for the deployer config
 *   --hash    → asks for an existing token and prints only its hash (switch a project without
 *               touching any deploy.json)
 * The deployer keeps only the hash; the client still sends the token itself (over HTTPS).
 */
export async function ProjectToken(mode: "generate" | "hash"): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    if (!input.isTTY) {
        console.error(red("✗ project-token needs an interactive terminal — its output is a secret and must not land in CI logs."));
        process.exit(1);
    }

    let token: string;
    if (mode === "generate") {
        token = crypto.randomBytes(32).toString("hex");
    } else {
        console.log(bold("\nHash an existing project token") + dim("  (the project config on the deployer)"));
        token = (await askHidden("Token: ")).trim();
        if (!token) { console.error(red("✗ Token is required.")); process.exit(1); }
        if (token.length < 32)
            console.log(yellow(`  ⚠ This token is short (${token.length} chars). Consider generating a new one: npx bmfk project-token`));
    }
    const hash = await PasswordHash.hash(token);

    console.log("");
    if (mode === "generate") {
        console.log(green(bold("✓ New project token")));
        console.log(`\n  deploy.json (your project, keep out of git):   "token": ${JSON.stringify(token)}`);
        console.log(`  project config on the deployer:                 "token": ${JSON.stringify(hash)}\n`);
    } else {
        console.log(green(bold("✓ Put this in the project config on the deployer instead of the plain token:")));
        console.log(`\n  "token": ${JSON.stringify(hash)}\n`);
    }
    console.log(dim("  The hash is salted — running this again gives a different, equally valid hash."));
}
