import fs from "fs";
import os from "os";
import path from "path";

// systemd user units for deployed projects: one per project, or one per blue-green slot,
// named bmfk-<project>[-<slot>].service in ~/.config/systemd/user. Written by the deployer
// (SystemdRunner), read by `bmfk ps`. Everything bmfk needs to know about a process is in the
// unit itself, under X-Bmfk-* keys (systemd ignores keys that start with X-), so there is no
// second registry to drift from what systemd runs.
//
// Values are never escaped into the file: anything that would need escaping (spaces, quotes, "%",
// "$", control characters) is refused before a unit is written.

export const UNIT_PREFIX = "bmfk-";

export interface IUnitSettings {
    // Extra node flags, one per entry: ["--max-old-space-size=512"].
    node_args?: string[];
    // Extra environment of the process.
    env?: Record<string, string>;
    // Memory limits: above memory_high the app is slowed down and pushed to free memory (MemoryHigh);
    // at memory_max it is killed and systemd starts it again (MemoryMax). "512M", "2G".
    memory_high?: string;
    memory_max?: string;
    // Seconds between SIGTERM and SIGKILL on stop/restart. Default 15.
    stop_timeout?: number;
    // Filesystem sandbox (read-only system and home, private /tmp; the deploy and data folders stay
    // writable). Default true. Needs user namespaces; turn off only where the kernel forbids them.
    sandbox?: boolean;
}

export interface IUnitSpec {
    id: number;
    name: string;               // process name: <project> or <project>-<slot>
    project: string;
    slot: "blue" | "green" | null;
    port: string | null;
    workingDirectory: string;   // the deploy (slot) folder
    node: string;               // absolute path of node
    entry: string;              // absolute path of the entry script
    sourceMaps: boolean;        // add --enable-source-maps
    dataDir: string;            // the project's data folder (stays writable in the sandbox)
    control?: string | null;    // the app's control socket (BMFK_CONTROL_SOCKET), in dataDir
    settings: IUnitSettings;
}

export interface IUnitInfo {
    unit: string;               // bmfk-shop-blue.service
    file: string;
    id: number | null;
    name: string;
    project: string | null;
    slot: "blue" | "green" | null;
    port: string | null;
    control: string | null;
}

const SAFE_PATH = /^\/[A-Za-z0-9._\/@+-]*$/;
const UNIT_NAME = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const NODE_ARG = /^--[a-z0-9][a-z0-9-]*(=[A-Za-z0-9._:\/,+=@-]*)?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VALUE = /^[^\x00-\x1f\x7f"\\%$]*$/;
const MEMORY = /^[1-9][0-9]*[KMGT]?$/;
// Set by the deployer itself; a project can't override them.
const RESERVED_ENV = new Set(["BMFK_UNIT", "BMFK_RUNNER", "BMFK_CONTROL_SOCKET"]);

// "512M" → bytes; null when not a size.
export function memoryBytes(v: unknown): number | null {
    if (typeof v !== "string" || !MEMORY.test(v)) return null;
    const unit = v.slice(-1), mul = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit];
    return mul ? Number(v.slice(0, -1)) * mul : Number(v);
}

export function unitName(name: string): string {
    return UNIT_PREFIX + name + ".service";
}

export function userUnitDir(): string {
    const base = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
        ? process.env.XDG_CONFIG_HOME
        : path.join(os.homedir(), ".config");
    return path.join(base, "systemd", "user");
}

// Problems with the "systemd" block of a project config, worded for the operator. Empty = fine.
export function settingsProblems(s: unknown): string[] {
    if (s === undefined || s === null) return [];
    if (typeof s !== "object" || Array.isArray(s)) return ['"systemd" must be an object'];
    const o = s as Record<string, unknown>, out: string[] = [];
    const known = new Set(["node_args", "env", "memory_high", "memory_max", "stop_timeout", "sandbox"]);
    for (const k of Object.keys(o)) if (!known.has(k)) out.push(`systemd.${k} is not a known setting`);
    if (o.node_args !== undefined) {
        if (!Array.isArray(o.node_args)) out.push("systemd.node_args must be a list of flags");
        else for (const a of o.node_args)
            if (typeof a !== "string" || (a !== "" && !NODE_ARG.test(a)))
                out.push(`systemd.node_args: ${JSON.stringify(a)} is not allowed — one "--flag" or "--flag=value" per entry, no spaces or quotes`);
    }
    if (o.env !== undefined) {
        if (typeof o.env !== "object" || o.env === null || Array.isArray(o.env)) out.push("systemd.env must be an object");
        else for (const [k, v] of Object.entries(o.env)) {
            if (!ENV_KEY.test(k)) out.push(`systemd.env: "${k}" is not a valid variable name`);
            else if (RESERVED_ENV.has(k)) out.push(`systemd.env: ${k} is set by the deployer`);
            if (typeof v !== "string" || !ENV_VALUE.test(v))
                out.push(`systemd.env.${k}: must be text without quotes, backslashes, "%", "$" or control characters`);
        }
    }
    for (const k of ["memory_high", "memory_max"] as const)
        if (o[k] !== undefined && (typeof o[k] !== "string" || !MEMORY.test(o[k] as string)))
            out.push(`systemd.${k}: ${JSON.stringify(o[k])} — a size such as "512M" or "2G"`);
    const high = memoryBytes(o.memory_high), max = memoryBytes(o.memory_max);
    if (high !== null && max !== null && high >= max)
        out.push(`systemd.memory_high (${o.memory_high}) must be below memory_max (${o.memory_max})`);
    if (o.stop_timeout !== undefined && (typeof o.stop_timeout !== "number" || !Number.isInteger(o.stop_timeout) || o.stop_timeout < 1 || o.stop_timeout > 600))
        out.push("systemd.stop_timeout: whole seconds, 1–600");
    if (o.sandbox !== undefined && typeof o.sandbox !== "boolean")
        out.push("systemd.sandbox: true or false");
    return out;
}

function specProblems(spec: IUnitSpec): string[] {
    const out = settingsProblems(spec.settings);
    if (!UNIT_NAME.test(spec.name)) out.push(`process name "${spec.name}" can't be a unit name`);
    for (const [what, p] of [["deploy folder", spec.workingDirectory], ["node", spec.node], ["entry", spec.entry], ["data folder", spec.dataDir],
        ...(spec.control ? [["control socket", spec.control]] : [])] as const)
        if (!SAFE_PATH.test(p)) out.push(`${what} path "${p}" — the systemd runner needs absolute paths of letters, digits and . _ / @ + - only`);
    if (spec.port !== null && !/^[0-9]{1,5}$/.test(spec.port)) out.push(`port "${spec.port}" is not a number`);
    if (!Number.isInteger(spec.id) || spec.id < 1) out.push(`bad process id ${spec.id}`);
    return out;
}

// The unit file text, or the reasons it can't be written.
export function renderUnit(spec: IUnitSpec): { text?: string; problems?: string[] } {
    const problems = specProblems(spec);
    if (problems.length) return { problems };
    const s = spec.settings ?? {};
    const nodeArgs = (s.node_args ?? []).filter(a => a !== "");
    if (spec.sourceMaps && !nodeArgs.includes("--enable-source-maps")) nodeArgs.unshift("--enable-source-maps");
    const sandbox = s.sandbox !== false;
    const unit = unitName(spec.name);

    const lines = [
        "# Written by the bmfk deployer on every deploy — changes here are overwritten.",
        "# Settings: the \"systemd\" block of the project config.",
        "[Unit]",
        `Description=bmfk ${spec.name}`,
        `X-Bmfk-Id=${spec.id}`,
        `X-Bmfk-Project=${spec.project}`,
        ...(spec.slot ? [`X-Bmfk-Slot=${spec.slot}`] : []),
        ...(spec.port ? [`X-Bmfk-Port=${spec.port}`] : []),
        ...(spec.control ? [`X-Bmfk-Control=${spec.control}`] : []),
        // Crash loop: more than 10 starts in 2 minutes → the unit stays failed (bmfk ps shows it).
        "StartLimitIntervalSec=120",
        "StartLimitBurst=10",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${spec.workingDirectory}`,
        `ExecStart=${[spec.node, ...nodeArgs, spec.entry].join(" ")}`,
        `Environment=BMFK_RUNNER=systemd`,
        `Environment=BMFK_UNIT=${unit}`,
        ...(spec.control ? [`Environment=BMFK_CONTROL_SOCKET=${spec.control}`] : []),
        ...Object.entries(s.env ?? {}).map(([k, v]) => `Environment="${k}=${v}"`),
        // Always, like pm2's autorestart: the monitor's restart is the process exiting.
        "Restart=always",
        "RestartSec=2",
        "KillSignal=SIGTERM",
        `TimeoutStopSec=${s.stop_timeout ?? 15}`,
        `SyslogIdentifier=${UNIT_PREFIX}${spec.name}`,
        ...(s.memory_high ? [`MemoryHigh=${s.memory_high}`] : []),
        ...(s.memory_max ? [`MemoryMax=${s.memory_max}`] : []),
        // Disk read/write per process for `bmfk ps show` (shown when the io controller is delegated).
        "IOAccounting=yes",
        "NoNewPrivileges=yes",
        ...(sandbox ? [
            "PrivateTmp=yes",
            "ProtectSystem=strict",
            "ProtectHome=read-only",
            // "-": a missing folder doesn't stop the start.
            `ReadWritePaths=-${spec.workingDirectory} -${spec.dataDir}`,
            "RestrictSUIDSGID=yes",
            "LockPersonality=yes",
        ] : []),
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ];
    return { text: lines.join("\n") };
}

// The X-Bmfk-* keys and the unit name of a unit file's text.
export function parseUnit(file: string, text: string): IUnitInfo {
    const get = (key: string) => {
        const m = text.match(new RegExp("^" + key + "=(.*)$", "m"));
        return m ? m[1].trim() : null;
    };
    const unit = path.basename(file);
    const id = Number(get("X-Bmfk-Id"));
    const slot = get("X-Bmfk-Slot");
    return {
        unit,
        file,
        id: Number.isInteger(id) && id > 0 ? id : null,
        name: unit.slice(UNIT_PREFIX.length, -".service".length),
        project: get("X-Bmfk-Project"),
        slot: slot === "blue" || slot === "green" ? slot : null,
        port: get("X-Bmfk-Port"),
        control: get("X-Bmfk-Control"),
    };
}

// Every bmfk unit in the folder, by id (units without an id last, by name).
export function listUnits(dir: string = userUnitDir()): IUnitInfo[] {
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return []; }
    const out: IUnitInfo[] = [];
    for (const f of files) {
        if (!f.startsWith(UNIT_PREFIX) || !f.endsWith(".service")) continue;
        const file = path.join(dir, f);
        try { out.push(parseUnit(file, fs.readFileSync(file, "utf-8"))); } catch { }
    }
    return out.sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity) || a.name.localeCompare(b.name));
}

// The id of a process: the one its unit already has, else the next free one. Ids never change
// once given, so `bmfk ps log 3` means the same process tomorrow.
export function allocateId(name: string, units: IUnitInfo[]): number {
    const own = units.find(u => u.name === name);
    if (own?.id) return own.id;
    return units.reduce((m, u) => Math.max(m, u.id ?? 0), 0) + 1;
}
