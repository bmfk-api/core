import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { IConfig, IProjectState } from "./ConfigService";
import { IError } from "../structures/Interfaces";
import { logInfo, logWarn } from "../LogService";
import { CONTROL_SOCKET_ENV, controlSocketPath } from "../control/Control";

// What starts and keeps a deployed project running. The project config picks it:
//
//   "runner": "pm2"      pm2, as before (the default when "pm2": true)
//   "runner": "systemd"  a systemd user unit per project (or per blue-green slot), see SystemdRunner
//   "runner": "none"     nothing is started (the default when "pm2": false)
//
// Without "runner", "pm2": true/false decides, so configs written for 1.0/1.1 keep working.

export type RunnerKind = "pm2" | "systemd" | "none";
export const RUNNER_KINDS: readonly RunnerKind[] = ["pm2", "systemd", "none"];

// The runner a project uses, or an error text for an unknown "runner".
export function runnerKind(found: Pick<IConfig, "pm2"> & { runner?: unknown }): RunnerKind | { error: string } {
    const r = found.runner;
    if (r === undefined || r === null || r === "") return found.pm2 ? "pm2" : "none";
    if (typeof r === "string" && (RUNNER_KINDS as readonly string[]).includes(r)) return r as RunnerKind;
    return { error: `"runner" must be one of ${RUNNER_KINDS.map(k => '"' + k + '"').join(", ")} (it is ${JSON.stringify(r)})` };
}

export interface IRunTarget {
    // The process name: the project name, or <project>-<slot> for a blue-green slot.
    name: string;
    // The project's own name (without the slot) and the slot, if any.
    project: string;
    slot: "blue" | "green" | null;
    // The folder the code was unpacked into (the slot folder for blue-green).
    destination: string;
    // The merged config of this deploy (base + slot), for the port shown by `bmfk ps`.
    config?: Record<string, unknown> | null;
}

export interface IProcessRunner {
    readonly kind: RunnerKind;
    // Starts the process, or restarts it with the code now in target.destination.
    start(found: IConfig, target: IRunTarget, projectState?: IProjectState | null): Promise<IError | null>;
}

// Absolute path of the entry point, from package.json "main" (default index.js). Returns null if
// package.json can't be read. Mirrors the legacy join so existing starts are unchanged.
export function entryPath(destination: string): string | null {
    let main: string;
    try {
        main = JSON.parse(fs.readFileSync(path.resolve(destination, "package.json"), "utf-8")).main || "index.js";
    } catch { return null; }
    if (main.startsWith("./")) main = main.substring(2);
    return destination.endsWith("/") ? destination + main : destination + "/" + main;
}

export class Pm2Runner implements IProcessRunner {
    readonly kind = "pm2" as const;

    // The pm2 CLI flags a deploy uses: the slot's own list for blue-green, else the project's.
    static attributesFor(found: IConfig, projectState?: IProjectState | null): string[] {
        const slotAttrs = projectState?.lastDeployed === "blue" ? found.bluegreen?.blue_pm2_attributes : found.bluegreen?.green_pm2_attributes;
        const list = Array.isArray(slotAttrs) ? slotAttrs : found.pm2_attributes;
        return Array.isArray(list) ? list.filter((s: unknown): s is string => typeof s === "string" && s.length > 0) : [];
    }

    // Add --enable-source-maps to pm2's --node-args. If the project already passes --node-args
    // (either "--node-args=X" or "--node-args" "X"), merge into it instead of adding a second one.
    static withSourceMaps(extra: string[]): string[] {
        const FLAG = "--enable-source-maps";
        const has = (v: string) => v.split(/\s+/).includes(FLAG);
        const inlineIdx = extra.findIndex(a => a.startsWith("--node-args="));
        if (inlineIdx !== -1) {
            const val = extra[inlineIdx].slice("--node-args=".length);
            if (has(val)) return extra;
            const next = [...extra];
            next[inlineIdx] = `--node-args=${(val + " " + FLAG).trim()}`;
            return next;
        }
        const splitIdx = extra.findIndex(a => a === "--node-args");
        if (splitIdx !== -1 && splitIdx + 1 < extra.length) {
            const val = extra[splitIdx + 1];
            if (has(val)) return extra;
            const next = [...extra];
            next[splitIdx + 1] = (val + " " + FLAG).trim();
            return next;
        }
        return [...extra, `--node-args=${FLAG}`];
    }

    async start(found: IConfig, target: IRunTarget, projectState?: IProjectState | null): Promise<IError | null> {
        const name = target.name, destination = target.destination;
        const pm2Attrs = Pm2Runner.attributesFor(found, projectState);

        // The app's control socket: pm2 passes the CLI's environment to the process it starts.
        const control = controlSocketPath(target.project, target.slot);
        const env = { ...process.env, ...(control ? { [CONTROL_SOCKET_ENV]: control } : {}) };
        if (!control) delete env[CONTROL_SOCKET_ENV];

        try {
            // check if pm2 is installed
            execFileSync("pm2", ["--version"]);

            // Autorestart guard: pm2 defaults autorestart=true, and our web/monitor restart
            // relies on it (the process self-exits and expects pm2 to respawn it). Strip any
            // "--no-autorestart" from the project's pm2 attributes so WE never disable it.
            const extra = pm2Attrs.filter(a => !/^--no-autorestart(=.*)?$/.test(a));
            if (extra.length !== pm2Attrs.length)
                logWarn(`Ignored "--no-autorestart" in pm2 attributes for "${name}" — autorestart is force-kept ON so the slot self-recovers.`);

            // Entry point and its sourcemap. A bundle (and any build that emits one) ships
            // <main>.map next to the entry; node needs --enable-source-maps for stack traces to
            // point at the original src/ lines. We add it automatically when the map is present.
            const entryMain = entryPath(destination);
            const hasMap = !!entryMain && fs.existsSync(entryMain + ".map");

            // Preferred path: ecosystem.config.{js,cjs} in the project root.
            // startOrReload picks up ALL changes (script path, args, exec_mode, cwd, interpreter);
            // --update-env forces re-read of env vars. Zero-downtime for cluster mode.
            const ecoJs = path.resolve(destination, "ecosystem.config.js");
            const ecoCjs = path.resolve(destination, "ecosystem.config.cjs");
            const ecosystem = fs.existsSync(ecoJs) ? ecoJs : fs.existsSync(ecoCjs) ? ecoCjs : null;

            if (ecosystem) {
                // We can't safely edit the project's own ecosystem file, so we can't inject the
                // flag here — tell the operator to add it themselves if a map is present.
                if (hasMap)
                    logInfo(`"${name}": a sourcemap ships next to the entry — add node_args:"--enable-source-maps" to ${path.basename(ecosystem)} for src-mapped stack traces`);
                execFileSync("pm2", ["startOrReload", ecosystem, "--update-env", ...extra], { env });
                // Ecosystem file may set autorestart:false explicitly — we can't safely override
                // a project file from the CLI, so verify and loudly warn if the slot won't recover.
                Pm2Runner.verifyAutorestart(name);
                return null;
            }

            // Fallback path: projects without an ecosystem file.
            // We must NOT use `pm2 restart` here — it re-uses the previously-stored exec_path,
            // so a change in package.json.main is silently ignored. delete+start guarantees
            // the current entry point is picked up (small ~1s downtime is acceptable).
            const list = execFileSync("pm2", ["list"]).toString();
            const running = list.split("\n").some(l => l.indexOf(name) !== -1);

            const script = entryMain ?? destination + "/index.js";

            if (running) {
                try { execFileSync("pm2", ["delete", name]); } catch { }
            }
            // Plain start defaults to autorestart=true (and we stripped any --no-autorestart
            // from `extra` above), so the slot is guaranteed self-recovering here.
            // With a sourcemap present, start node with --enable-source-maps (merged into any
            // --node-args the project already passes).
            const startExtra = hasMap ? Pm2Runner.withSourceMaps(extra) : extra;
            execFileSync("pm2", ["start", script, "--name", name, ...startExtra], { env });
            Pm2Runner.verifyAutorestart(name);
            return null;
        } catch (e) {
            return { code: 18, message: "Can't run pm2", details: "" + e, httpStatus: 500 };
        }
    }

    // Best-effort probe: after pm2 start/reload, confirm autorestart is ON for this process.
    // We can't force-override an ecosystem file's explicit autorestart:false from the CLI, so if
    // it's off we warn loudly — a disabled slot will NOT come back after a monitor/web restart.
    private static verifyAutorestart(name: string) {
        try {
            const list = JSON.parse(execFileSync("pm2", ["jlist"]).toString());
            const proc = Array.isArray(list) ? list.find((p: any) => p?.name === name) : null;
            if (proc?.pm2_env && proc.pm2_env.autorestart === false) {
                logWarn(`pm2 autorestart is DISABLED for "${name}" — the slot will NOT respawn after a restart/exit. Check the project's ecosystem.config (autorestart:false).`);
            }
        } catch (e: any) {
            // Verification is diagnostic only; never fail a deploy because jlist couldn't be read.
            logWarn(`Could not verify pm2 autorestart for "${name}": ${e?.message ?? e}`);
        }
    }
}
