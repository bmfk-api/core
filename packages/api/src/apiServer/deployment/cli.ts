#!/usr/bin/env node
// CLI entry point exposed via package.json "bin" as `bmfk`.
// In a consumer project's package.json scripts you can then write:
//   "deploy":        "bmfk deploy"
//   "activate":      "bmfk activate"
//   "rollback":      "bmfk activate blue"   (or green)
// Both commands auto-discover the config (deploy/ folder → deploy.json), same as calling
// Deploy()/Activate() with no argument.
//
// An explicit config path can be passed to override auto-discovery. Via npm this needs the
// `--` separator so npm forwards the arg to the script:
//   npm run deploy -- deploy/custom.json
//   npm run activate -- deploy/custom.json blue
// Order of positional args is free — the slot ("blue"/"green") and the config path are told
// apart by value, so both `activate custom.json blue` and `activate blue custom.json` work.

import { Deploy } from "./Deploy";
import { Activate } from "./Activate";
import { Status } from "./Status";
import { Backups } from "./Backups";
import { Restore } from "./Restore";
import { BackupManager } from "./BackupManager";
import { HashPassword, ProjectToken } from "./HashPassword";
import { ProjectConfigWizard } from "./ProjectConfigWizard";
import { AccessConfigWizard } from "./AccessConfigWizard";
import { MigrateConfigsWizard } from "./MigrateConfigsWizard";
import { SetupConfigWizard } from "./SetupConfigWizard";
import { Wizards } from "./Wizards";
import { DeployKeyWizard, MicroserviceKey } from "./DeployKeyWizard";
import { MigrateProject } from "./MigrateProject";
import { DeployerInit } from "./DeployerInit";
import { Ps } from "./Ps";

function usage(): never {
    console.error("Usage:");
    console.error("  bmfk wizards                              — list every interactive wizard and run one");
    console.error("  bmfk deploy [config.json]                 — build + upload the current project");
    console.error("  bmfk activate [config.json] [blue|green]  — switch blue-green slot (omit slot for lastDeployed)");
    console.error("  bmfk status [config.json]                 — show active / last deployed slot");
    console.error("  bmfk backups [config.json]                — list deploy backups");
    console.error("  bmfk restore [config.json] [backup] [--yes] — restore a backup (asks which, and confirms)");
    console.error("  bmfk hash-password [--deployer]          — hash a password for the monitor (or deployer setup.json)");
    console.error("  bmfk project-token [--hash]               — new project token + its hash (or hash an existing one)");
    console.error("  bmfk project-config                       — build a project config for the deployer, step by step");
    console.error("  bmfk access-config [file]                 — create or edit access.json (found in the project's code if omitted)");
    console.error("  bmfk migrate-configs [folder] [--yes]     — hash the secrets of old setup.json, project configs and access.json files");
    console.error("  bmfk setup-config [file|folder]           — edit the deployer's setup.json: users, reviewers, allowed IPs");
    console.error("  bmfk deploy-key [deploy.json]             — a signing key pair: private key into deploy.json, public key for setup.json");
    console.error("  bmfk ms-key                               — a signing key pair for a microservice host or caller");
    console.error("  bmfk migrate [folder] [--write]           — move a project from the legacy server 6.x (shows the plan; --write applies it)");
    console.error("  bmfk deployer-init [folder]               — set up a deployer on this server: service, pm2, setup.json, nginx");
    console.error("  bmfk ps [list|log|show|start|stop|restart|startup|boot-check] — processes run by the deployer under systemd (bmfk ps help)");
    console.error("");
    console.error("Config path is optional (auto-discovers deploy/ folder → deploy.json when omitted).");
    console.error("Via npm, prefix args with --   e.g.  npm run deploy -- deploy/custom.json");
    process.exit(1);
}

// Split the positional args (everything after the command) into a slot and a config path.
// A "blue"/"green" token is the slot; any other token is treated as the config path.
function parseArgs(args: string[]): { scheme?: "blue" | "green"; config?: string } {
    let scheme: "blue" | "green" | undefined;
    let config: string | undefined;
    for (const a of args) {
        if (a === "blue" || a === "green") {
            if (scheme) { console.error(`Slot specified twice ("${scheme}" and "${a}").`); process.exit(1); }
            scheme = a;
        } else {
            if (config) { console.error(`Config path specified twice ("${config}" and "${a}").`); process.exit(1); }
            config = a;
        }
    }
    return { scheme, config };
}

async function main() {
    const command = process.argv[2];
    const rest = process.argv.slice(3);

    switch (command) {
        case "deploy": {
            const { scheme, config } = parseArgs(rest);
            if (scheme) {
                console.error(`"deploy" does not take a slot argument ("${scheme}").`);
                process.exit(1);
            }
            await Deploy(config);   // undefined → auto-discover
            break;
        }

        case "activate": {
            const { scheme, config } = parseArgs(rest);
            await Activate(config, scheme);   // both optional
            break;
        }

        case "backups": {
            const { scheme, config } = parseArgs(rest);
            if (scheme) {
                console.error(`"backups" does not take a slot argument ("${scheme}").`);
                process.exit(1);
            }
            await Backups(config);
            break;
        }

        case "restore": {
            // Tokens are told apart by value: a backup name has a fixed timestamp shape, --yes is
            // a flag, anything else is the config path.
            let config: string | undefined, backup: string | undefined, yes = false;
            for (const a of rest) {
                if (a === "--yes" || a === "-y") { yes = true; continue; }
                if (BackupManager.isValidName(a)) {
                    if (backup) { console.error(`Backup specified twice ("${backup}" and "${a}").`); process.exit(1); }
                    backup = a;
                    continue;
                }
                if (config) { console.error(`Config path specified twice ("${config}" and "${a}").`); process.exit(1); }
                config = a;
            }
            await Restore(config, backup, yes);
            break;
        }

        case "hash-password": {
            const unknown = rest.filter(a => a !== "--deployer");
            if (unknown.length) {
                console.error("hash-password takes no arguments except --deployer — the password is asked interactively.");
                process.exit(1);
            }
            await HashPassword(rest.includes("--deployer") ? "deployer" : "monitor");
            break;
        }

        case "wizards": {
            if (rest.length) {
                console.error("wizards takes no arguments.");
                process.exit(1);
            }
            await Wizards();
            break;
        }

        case "deploy-key": {
            if (rest.length > 1) {
                console.error("Usage: bmfk deploy-key [deploy.json]");
                process.exit(1);
            }
            await DeployKeyWizard(rest[0]);
            break;
        }

        case "ms-key": {
            if (rest.length > 0) {
                console.error("Usage: bmfk ms-key");
                process.exit(1);
            }
            MicroserviceKey();
            break;
        }

        case "setup-config": {
            if (rest.length > 1) {
                console.error("Usage: bmfk setup-config [file|folder]");
                process.exit(1);
            }
            await SetupConfigWizard(rest[0]);
            break;
        }

        case "deployer-init": {
            if (rest.length > 1 || rest.some(a => a.startsWith("-"))) {
                console.error("Usage: bmfk deployer-init [folder]");
                process.exit(1);
            }
            await DeployerInit(rest);
            break;
        }

        case "migrate": {
            if (rest.some(a => a.startsWith("-") && a !== "--write")) {
                console.error("Usage: bmfk migrate [folder] [--write]");
                process.exit(1);
            }
            await MigrateProject(rest);
            break;
        }

        case "migrate-configs": {
            const assumeYes = rest.includes("--yes") || rest.includes("-y");
            const folders = rest.filter(a => a !== "--yes" && a !== "-y");
            if (folders.length > 1 || folders.some(a => a.startsWith("-"))) {
                console.error("Usage: bmfk migrate-configs [folder] [--yes]");
                process.exit(1);
            }
            await MigrateConfigsWizard(folders[0], assumeYes);
            break;
        }

        case "access-config": {
            if (rest.length > 1) {
                console.error("access-config takes at most one argument: the path to the access file.");
                process.exit(1);
            }
            await AccessConfigWizard(rest[0]);
            break;
        }

        case "project-config": {
            if (rest.length) {
                console.error("project-config takes no arguments — everything is asked interactively.");
                process.exit(1);
            }
            await ProjectConfigWizard();
            break;
        }

        case "project-token": {
            const unknown = rest.filter(a => a !== "--hash");
            if (unknown.length) {
                console.error("project-token takes no arguments except --hash — an existing token is asked interactively.");
                process.exit(1);
            }
            await ProjectToken(rest.includes("--hash") ? "hash" : "generate");
            break;
        }

        case "ps": {
            process.exitCode = await Ps(rest);
            break;
        }

        case "status": {
            const { scheme, config } = parseArgs(rest);
            if (scheme) {
                console.error(`"status" does not take a slot argument ("${scheme}").`);
                process.exit(1);
            }
            await Status(config);
            break;
        }

        default:
            if (command) console.error(`Unknown command: ${command}\n`);
            usage();
    }
}

main().catch((err) => {
    // Deploy/Activate already print rich, colored failure panels and call process.exit for
    // known error paths. This catch handles anything that throws before that (config resolution,
    // build step, etc.) so the process exits non-zero with a readable message instead of an
    // unhandled-rejection stack dump.
    console.error("\n" + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
});
