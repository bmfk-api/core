import fs from "fs";
import path from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { InterceptorSignedAuth } from "../interceptors/InterceptorSignedAuth";
import type { IBundleOptions } from "./Bundler";

// Shared config shape for Deploy() and Activate(). Both commands read the same JSON file(s);
// the extra optional fields are simply ignored by whichever command doesn't use them
// (Deploy ignores switch_host, Activate ignores includes/excludes).
export interface IDeployerConfig {
    name: string,
    token: string,
    host: string,
    username: string,
    // Either a password (the old way) or an Ed25519 private key (base64 PKCS#8, from
    // `bmfk deploy-key`) to sign every request. Both are secrets: keep this file out of git.
    password?: string,
    privateKey?: string,
    // Deploy: extra files/dirs to ship beyond ./bin (or ./dist).
    //   "certs"                                   → archived at its own path: certs/
    //   { src:"assets/x.png", dest:"bin/x.png" }  → archived at the given path inside the slot
    // A plain string is exactly { src, dest: src }. Directories are copied/archived whole.
    includes?: (string | { src: string, dest?: string })[],
    excludes?: string[],   // Deploy: tar --exclude patterns
    // Deploy: the app's own code as ONE file at package.json "main" (packages stay in node_modules,
    // the server still runs npm ci). true, or { entry?: "src/Main.ts", sourcemap?: false }. See Bundler.ts.
    bundle?: boolean | IBundleOptions,
    versionBump?: boolean, // Deploy: false keeps package.json "version" as it is (default: patch + 1 on every deploy)
    switch_host?: string,  // Activate: explicit /switch URL override
}

// The token, the archive and review links travel over this address: https, or http to this machine
// only (an SSH tunnel). Null when it's acceptable.
export function transportProblem(url: string): string | null {
    let u: URL;
    try { u = new URL(url); } catch { return `"${url}" is not a URL`; }
    if (u.protocol === "https:") return null;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.protocol === "http:" && (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host))) return null;
    return `"${url}" must be https (http only to localhost, e.g. through an SSH tunnel)`;
}

// Returns null if the config has all required fields and valid optional shapes, otherwise a
// human-readable reason. Single source of truth for validation — used both to filter the
// deploy/ folder listing and as the final gate after resolving.
export function validateConfig(cfg: any): string | null {
    if (!cfg || typeof cfg !== "object") return "not an object";
    if (!cfg.name || !cfg.token || !cfg.host || !cfg.username)
        return "missing one of: name, token, host, username";
    const insecure = transportProblem(String(cfg.host));
    if (insecure) return "host: " + insecure;
    if (cfg.switch_host && typeof cfg.switch_host === "string") {
        const s = transportProblem(cfg.switch_host);
        if (s) return "switch_host: " + s;
    }
    if (!cfg.password && !cfg.privateKey)
        return "missing credentials: privateKey (signed requests) or password";
    if (cfg.privateKey) {
        try { InterceptorSignedAuth.publicKeyOf(cfg.privateKey); }
        catch { return "privateKey is not a valid Ed25519 key (base64 PKCS#8)"; }
    }
    if (cfg.includes) {
        if (!Array.isArray(cfg.includes)) return "includes must be an array";
        for (const inc of cfg.includes) {
            if (typeof inc === "string") continue;
            if (!inc || typeof inc !== "object")
                return "includes entries must be a string or { src, dest? }";
            if (typeof inc.src !== "string" || inc.src.length === 0)
                return "includes entry is missing a non-empty 'src'";
            if (inc.dest !== undefined && (typeof inc.dest !== "string" || inc.dest.length === 0))
                return `includes entry "${inc.src}" has an invalid 'dest'`;
        }
    }
    if (cfg.excludes && !Array.isArray(cfg.excludes)) return "excludes must be an array";
    if (cfg.versionBump !== undefined && typeof cfg.versionBump !== "boolean")
        return "versionBump must be true or false";
    if (cfg.bundle !== undefined && typeof cfg.bundle !== "boolean") {
        if (!cfg.bundle || typeof cfg.bundle !== "object" || Array.isArray(cfg.bundle))
            return "bundle must be true/false or { entry?, sourcemap? }";
        if (cfg.bundle.entry !== undefined && (typeof cfg.bundle.entry !== "string" || cfg.bundle.entry.length === 0))
            return "bundle.entry must be a non-empty path";
        if (cfg.bundle.sourcemap !== undefined && typeof cfg.bundle.sourcemap !== "boolean")
            return "bundle.sourcemap must be true or false";
        if (cfg.bundle.minify !== undefined && typeof cfg.bundle.minify !== "boolean")
            return "bundle.minify must be true or false";
    }
    if (cfg.switch_host && typeof cfg.switch_host !== "string") return "switch_host must be a string";
    return null;
}

// Interactive picker for the deploy/ folder case. Auto-selects when there's only one config.
// Throws (rather than hangs) in a non-TTY context where we can't prompt.
async function selectConfig(configs: IDeployerConfig[]): Promise<IDeployerConfig> {
    if (configs.length === 0) {
        throw new Error("No valid deploy configs found");
    }

    if (configs.length === 1) {
        console.log(`Using deploy config: ${configs[0].name}`);
        return configs[0];
    }

    if (!input.isTTY) {
        throw new Error(
            `Found ${configs.length} deploy configs (${configs.map(c => c.name).join(", ")}) but stdin is not a TTY — ` +
            `cannot prompt for a choice. Pass a specific config explicitly, e.g. "deploy/<name>.json".`
        );
    }

    console.log("\nAvailable deploy configs:\n");
    configs.forEach((config, index) => {
        console.log(`[${index + 1}] ${config.name ?? "bad-config-file"}`);
    });

    const rl = createInterface({ input, output });
    try {
        while (true) {
            const answer = await rl.question(`\nChoose config [1-${configs.length}]: `);
            const selectedIndex = Number.parseInt(answer.trim(), 10) - 1;
            if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < configs.length) {
                return configs[selectedIndex];
            }
            console.error(`Invalid selection. Enter a number from 1 to ${configs.length}.`);
        }
    } finally {
        rl.close();
    }
}

/**
 * Resolves a deploy config from various inputs, shared by Deploy() and Activate().
 *
 * @param opt  One of:
 *   - undefined/null → auto-discover: `deploy/` folder (interactive pick) → `deploy.json` fallback;
 *   - string → path to a JSON config file;
 *   - object → an inline config (validated as-is).
 *
 * @returns a validated IDeployerConfig object. Throws with an actionable message otherwise.
 */
export async function resolveConfig(opt?: IDeployerConfig | string | null): Promise<IDeployerConfig> {
    // Auto-discover when nothing was passed.
    // Priority: deploy/ folder (multi-config, interactive pick) → single deploy.json fallback.
    if (!opt) {
        const dir = path.resolve("deploy");
        const single = path.resolve("deploy.json");

        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
            if (files.length === 0)
                throw new Error(`No .json configs found in ${dir}`);

            // Keep only valid configs — a broken one must not appear as a selectable menu entry.
            const configs: IDeployerConfig[] = [];
            for (const f of files) {
                const filePath = path.resolve(dir, f);
                let parsed: any;
                try {
                    parsed = JSON.parse(fs.readFileSync(filePath).toString("utf-8"));
                } catch (e) {
                    console.error(`Skipping ${f}: failed to parse JSON:`, (e as Error).message);
                    continue;
                }
                const reason = validateConfig(parsed);
                if (reason) {
                    console.error(`Skipping ${f}: ${reason}`);
                    continue;
                }
                configs.push(parsed as IDeployerConfig);
            }

            if (configs.length === 0)
                throw new Error(`No valid deploy configs in ${dir} (all ${files.length} were skipped)`);

            opt = await selectConfig(configs);
        } else if (fs.existsSync(single)) {
            opt = single;   // fall through to string-path branch
        } else {
            throw new Error(`No deploy config found: neither ${dir}/ nor ${single} exists`);
        }
    }

    // String path (explicit arg, or the deploy.json fallback above) — read + parse.
    if (typeof opt === "string") {
        if (!fs.existsSync(opt)) {
            throw new Error(`Config file not found: ${opt}`);
        }
        opt = JSON.parse(fs.readFileSync(opt).toString("utf-8")) as IDeployerConfig;
    }

    // Final gate — covers inline objects too.
    const invalidReason = validateConfig(opt);
    if (invalidReason) {
        throw new Error(`Invalid deploy config: ${invalidReason}`);
    }

    return opt;
}
