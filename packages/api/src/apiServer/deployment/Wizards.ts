import { stdin as input } from "process";
import { palette } from "./cliCommon";
import { ask, yes } from "./cliPrompt";
import { HashPassword, ProjectToken } from "./HashPassword";
import { ProjectConfigWizard } from "./ProjectConfigWizard";
import { AccessConfigWizard } from "./AccessConfigWizard";
import { SetupConfigWizard } from "./SetupConfigWizard";
import { MigrateConfigsWizard } from "./MigrateConfigsWizard";
import { DeployKeyWizard } from "./DeployKeyWizard";
import { DeployerInit } from "./DeployerInit";

interface IWizard {
    command: string;     // the direct way to run it, shown for later
    title: string;
    what: string;
    where: string;
    run: () => Promise<void>;
}

const WIZARDS: IWizard[] = [
    { command: "bmfk deployer-init [folder]", title: "New deployer on this server",
      what: "Checks Node, systemd or pm2 and the data folder, asks for port, folders, the first deploy users' public keys, allowed addresses and Telegram, then writes the service, its systemd unit (started at boot) or pm2 file and setup.json, and prints the nginx block and the next steps.",
      where: "on the server, in an empty folder with @bmfk/api installed",
      run: () => DeployerInit([]) },
    { command: "bmfk project-config", title: "New project config for the deployer",
      what: "Asks for everything a project needs (folder, token, deploy steps, config values, blue-green, nginx, secrets file, review) and writes the deployer's project config plus a matching deploy.json.",
      where: "anywhere; copy the config to the deployer's projects folder",
      run: () => ProjectConfigWizard() },
    { command: "bmfk setup-config [file|folder]", title: "Deployer users, reviewers and allowed IPs",
      what: "Edits the deployer's setup.json from a menu: add, rename or remove deployer users, change passwords or set their public signing keys, require signed requests, manage reviewers, allowed addresses and the review page URL.",
      where: "on the deployer server",
      run: () => SetupConfigWizard() },
    { command: "bmfk deploy-key [deploy.json]", title: "Signing key for deploys",
      what: "Generates an Ed25519 key pair: writes the private key into deploy.json (instead of the password) and prints the public key for the deployer's setup.json. Signed requests can't be replayed or altered.",
      where: "in the project folder you deploy from",
      run: () => DeployKeyWizard() },
    { command: "bmfk access-config [file]", title: "Monitor and documentation access",
      what: "Creates or edits an app's access.json: monitor users with roles and passwords, documentation users, the monitor's allowed addresses. Finds the file named in the project's code.",
      where: "on the app server, or in the project folder",
      run: () => AccessConfigWizard() },
    { command: "bmfk migrate-configs [folder] [--yes]", title: "Upgrade old configs to hashed secrets",
      what: "Hashes the plain passwords and tokens in old setup.json, project configs and access.json files, computing each hash from the value already there; clients keep their deploy.json.",
      where: "on the servers, right after upgrading to 6.x",
      run: () => MigrateConfigsWizard() },
    { command: "bmfk project-token", title: "New project token",
      what: "Generates a random project token: the token itself for deploy.json and its hash for the project config.",
      where: "anywhere",
      run: () => ProjectToken("generate") },
    { command: "bmfk project-token --hash", title: "Hash an existing project token",
      what: "Asks for a token you already use and prints its hash for the project config.",
      where: "anywhere",
      run: () => ProjectToken("hash") },
    { command: "bmfk hash-password", title: "Hash a monitor password",
      what: "Prints a monitor user entry with a hashed password, to paste into access.json or the access option.",
      where: "anywhere",
      run: () => HashPassword("monitor") },
    { command: "bmfk hash-password --deployer", title: "Hash a deployer password",
      what: "Prints a deployer user entry with a hashed password, to paste into setup.json.",
      where: "anywhere",
      run: () => HashPassword("deployer") },
];

/** `bmfk wizards` — every interactive tool of the package in one list, each runnable from here. */
export async function Wizards(): Promise<void> {
    const { red, dim, bold, green } = palette();
    if (!input.isTTY) {
        console.error(red("✗ wizards is interactive — run it in a terminal. To script, call a command directly (see `bmfk` for the list)."));
        process.exit(1);
    }
    for (;;) {
        console.log(bold("\nbmfk wizards\n"));
        WIZARDS.forEach((w, i) => {
            console.log(`  ${bold(String(i + 1).padStart(2) + ")")} ${bold(w.title)}`);
            console.log(`      ${w.what}`);
            console.log(dim(`      where: ${w.where}  ·  directly: npx ${w.command}`));
        });
        console.log(`\n   ${bold("q)")} quit`);
        const choice = (await ask("\nChoose", "")).toLowerCase();
        if (choice === "q" || choice === "") return;
        const w = WIZARDS[Number(choice) - 1];
        if (!/^\d+$/.test(choice) || !w) { console.log(red("  ✗ choose a number or q")); continue; }
        console.log(green(`\n→ ${w.title}`) + dim(`  (next time: npx ${w.command})`));
        await w.run();
        if (!(await yes("\nBack to the list of wizards?", false))) return;
    }
}
