import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { IConfig, IProjectState } from "./ConfigService";
import { IError } from "../structures/Interfaces";
import { logInfo } from "../LogService";
import { AppData } from "../helper/AppDataPath";
import { IProcessRunner, IRunTarget, entryPath } from "./ProcessRunner";
import { controlSocketPath } from "../control/Control";
import { IUnitSettings, allocateId, listUnits, renderUnit, unitName, userUnitDir } from "./SystemdUnit";

const execFileAsync = promisify(execFile);

// Runs `systemctl --user …` (or journalctl). Injected in tests.
export type Systemctl = (args: string[]) => Promise<string>;

// systemctl --user finds the user's manager through XDG_RUNTIME_DIR / the user bus. Under a unit
// both are set; under pm2 or a plain shell they may not be — they are derived from the uid then.
export function userManagerEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!env.XDG_RUNTIME_DIR && uid !== null) env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
    if (!env.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
    return env;
}

export const realSystemctl: Systemctl = async (args) => {
    const r = await execFileAsync("systemctl", ["--user", ...args], { env: userManagerEnv(), timeout: 60_000 });
    return String(r.stdout);
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A deployed project as a systemd user unit (see SystemdUnit.ts): written on every deploy, enabled
// (so it starts at boot — with `loginctl enable-linger` for the deployer's user), then restarted.
export class SystemdRunner implements IProcessRunner {
    readonly kind = "systemd" as const;

    constructor(private readonly opts: {
        systemctl?: Systemctl;
        unitDir?: string;
        node?: string;
        // How long to watch the process after the restart before calling the deploy good.
        settleMs?: number;
        platform?: NodeJS.Platform;
    } = {}) { }

    async start(found: IConfig, target: IRunTarget, _projectState?: IProjectState | null): Promise<IError | null> {
        const fail = (message: string, details: string): IError => ({ code: 67, message, details, httpStatus: 500 });
        if ((this.opts.platform ?? process.platform) !== "linux")
            return fail("The systemd runner works only on Linux.", `"${target.name}" has "runner": "systemd", this server is ${process.platform}`);

        const systemctl = this.opts.systemctl ?? realSystemctl;
        const dir = this.opts.unitDir ?? userUnitDir();
        const entry = entryPath(target.destination) ?? path.join(target.destination, "index.js");
        const dataDir = AppData.projectDir(target.project);
        const units = listUnits(dir);

        const rendered = renderUnit({
            id: allocateId(target.name, units),
            name: target.name,
            project: target.project,
            slot: target.slot,
            port: portOf(target.config),
            workingDirectory: path.resolve(target.destination),
            node: this.opts.node ?? process.execPath,
            entry: path.resolve(entry),
            sourceMaps: fs.existsSync(entry + ".map"),
            dataDir,
            control: controlSocketPath(target.project, target.slot),
            settings: ((found as any).systemd ?? {}) as IUnitSettings,
        });
        if (!rendered.text)
            return { code: 68, message: "The systemd settings of the project are not valid.", details: rendered.problems!.join("; "), httpStatus: 400 };

        const unit = unitName(target.name);
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
            const file = path.join(dir, unit);
            const tmp = file + ".tmp";
            fs.writeFileSync(tmp, rendered.text, { mode: 0o644 });
            fs.renameSync(tmp, file);

            await systemctl(["daemon-reload"]);
            await systemctl(["enable", unit]);
            // Clear a crash-loop "failed" left by an earlier deploy, then (re)start with the new code.
            await systemctl(["reset-failed", unit]).catch(() => "");
            await systemctl(["restart", unit]);
        } catch (e: any) {
            return fail(`Can't start ${unit}.`, String(e?.stderr || e?.message || e).trim());
        }

        // A process that dies at once still leaves `restart` successful: it must be running, and
        // still the same process (Restart=always would quietly replace a crashed one), a moment later.
        const settle = this.opts.settleMs ?? 3000;
        if (settle > 0) {
            const probe = async () => {
                const out = await systemctl(["show", unit, "--property=ActiveState", "--property=SubState", "--property=MainPID"]).catch(() => "");
                const v: Record<string, string> = {};
                for (const l of out.split("\n")) { const i = l.indexOf("="); if (i > 0) v[l.slice(0, i)] = l.slice(i + 1).trim(); }
                return v;
            };
            const first = await probe();
            await sleep(settle);
            const last = await probe();
            if (last.ActiveState !== "active" || last.SubState !== "running" || !last.MainPID || last.MainPID === "0" || last.MainPID !== first.MainPID)
                return fail(`${unit} doesn't stay up after the deploy.`,
                    `state ${last.ActiveState || "?"}/${last.SubState || "?"}, pid ${first.MainPID || "?"} → ${last.MainPID || "?"} — see: bmfk ps log ${target.name}`);
        }
        logInfo(`"${target.name}" runs as systemd user unit ${unit}`);
        return null;
    }
}

function portOf(config: Record<string, unknown> | null | undefined): string | null {
    if (!config) return null;
    for (const k of Object.keys(config))
        if (k.toLowerCase() === "port" && config[k] !== null && config[k] !== undefined && /^[0-9]{1,5}$/.test(String(config[k])))
            return String(config[k]);
    return null;
}
