// `bmfk ps` — the processes the deployer runs as systemd user units, pm2-style:
//
//   bmfk ps [list]                      table of every process (and pm2's, if any)
//   bmfk ps watch [-i 2]                the list, redrawn every few seconds
//   bmfk ps log <id|name|all> [-f] [-n 100] [--errors] [--since 1h]
//   bmfk ps show <id|name>              details: unit, paths, state, last exit, recent log
//   bmfk ps start|stop|restart <id|name|all>
//   bmfk ps loglevel <id|name|all> [all|api|info|db|warn|error|crit]
//   bmfk ps startup                     what's missing for the processes to start at boot, and how to fix it
//   bmfk ps boot-check                  what starts after a reboot
//
// It talks to systemd directly (systemctl --user, journalctl), never to the deployer, so it works
// while the deployer is down. Only bmfk-*.service units from the user's unit folder are touched:
// an argument is looked up there first and only a unit found there reaches systemctl.

import fs from "fs";
import os from "os";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { palette } from "./cliCommon";
import { IUnitInfo, listUnits, userUnitDir, UNIT_PREFIX } from "./SystemdUnit";
import { Systemctl, realSystemctl, userManagerEnv } from "./SystemdRunner";
import { ControlOp, IControlMetrics, IControlPing, IControlReady, LOG_LEVEL_NAMES, controlCall } from "../control/Control";

const execFileAsync = promisify(execFile);

// ---- pure parts (tested) --------------------------------------------------------------------

export interface IUnitState {
    activeState: string;      // active / inactive / failed / activating / deactivating
    subState: string;         // running / dead / auto-restart / exited …
    pid: number | null;
    restarts: number | null;
    memory: number | null;    // bytes
    memoryPeak: number | null;
    tasks: number | null;     // threads
    ioRead: number | null;    // bytes since start
    ioWrite: number | null;
    cpuNs: number | null;     // total CPU time, ns
    activeSinceUs: number | null; // CLOCK_MONOTONIC µs of the last start
    enabled: boolean;         // starts at boot
    result: string | null;    // success / exit-code / signal / start-limit-hit …
    exitStatus: string | null;
}

export const SHOW_PROPERTIES = ["Id", "ActiveState", "SubState", "MainPID", "NRestarts", "MemoryCurrent", "CPUUsageNSec",
    "ActiveEnterTimestampMonotonic", "UnitFileState", "Result", "ExecMainStatus", "MemoryPeak", "TasksCurrent", "IOReadBytes", "IOWriteBytes"];

const num = (v: string | undefined): number | null => {
    if (v === undefined || v === "" || v === "[not set]") return null;
    const n = Number(v);
    // systemd prints UINT64_MAX for "unknown".
    return Number.isFinite(n) && n >= 0 && n < 1.8e19 ? n : null;
};

// `systemctl show a b --property=…`: one block per unit, separated by a blank line. Keyed by Id.
export function parseShow(out: string): Map<string, IUnitState> {
    const res = new Map<string, IUnitState>();
    for (const block of out.split(/\n\s*\n/)) {
        const v: Record<string, string> = {};
        for (const l of block.split("\n")) { const i = l.indexOf("="); if (i > 0) v[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
        if (!v.Id) continue;
        const pid = num(v.MainPID);
        res.set(v.Id, {
            activeState: v.ActiveState || "unknown",
            subState: v.SubState || "",
            pid: pid ? pid : null,
            restarts: num(v.NRestarts),
            memory: num(v.MemoryCurrent),
            memoryPeak: num(v.MemoryPeak),
            tasks: num(v.TasksCurrent),
            ioRead: num(v.IOReadBytes),
            ioWrite: num(v.IOWriteBytes),
            cpuNs: num(v.CPUUsageNSec),
            activeSinceUs: num(v.ActiveEnterTimestampMonotonic) || null,
            enabled: v.UnitFileState === "enabled" || v.UnitFileState === "enabled-runtime",
            result: v.Result || null,
            exitStatus: v.ExecMainStatus || null,
        });
    }
    return res;
}

// An argument → the units it names: an id, a process name (shop-blue), a project (shop → both
// slots), or "all". Unknown → [].
export function resolveTargets(arg: string, units: IUnitInfo[], allowAll: boolean): IUnitInfo[] {
    if (allowAll && arg === "all") return units;
    if (/^[0-9]+$/.test(arg)) return units.filter(u => u.id === Number(arg));
    const exact = units.filter(u => u.name === arg || u.unit === arg);
    if (exact.length) return exact;
    return units.filter(u => u.project === arg);
}

export interface ILogOptions { follow: boolean; lines: number; errors: boolean; since: string | null }

export function parseLogArgs(args: string[]): { target?: string; opts?: ILogOptions; error?: string } {
    const opts: ILogOptions = { follow: false, lines: 100, errors: false, since: null };
    let target: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-f" || a === "--follow") opts.follow = true;
        else if (a === "--errors" || a === "-e") opts.errors = true;
        else if (a === "-n" || a === "--lines") {
            const v = args[++i];
            if (!v || !/^[0-9]{1,6}$/.test(v)) return { error: `${a} needs a number of lines` };
            opts.lines = Number(v);
        } else if (a === "--since") {
            const v = args[++i];
            if (!v) return { error: "--since needs a time: 1h, 30m, 2d, or \"2026-11-27 10:00\"" };
            const rel = v.match(/^([0-9]{1,5})([smhd])$/);
            if (rel) opts.since = `-${rel[1]}${rel[2]}`;
            else if (/^[0-9: -]{4,19}$/.test(v) || ["today", "yesterday"].includes(v)) opts.since = v;
            else return { error: `--since "${v}": use 1h, 30m, 2d, "2026-11-27 10:00", today or yesterday` };
        } else if (a.startsWith("-")) return { error: `unknown option ${a}` };
        else if (target) return { error: `one process at a time ("${target}" and "${a}")` };
        else target = a;
    }
    if (!target) return { error: "which process? an id or a name from `bmfk ps list`, or all" };
    return { target, opts };
}

export function journalArgs(units: IUnitInfo[] | "all", o: ILogOptions): string[] {
    // --user-unit reads the units of this user from every journal the user may read: their own
    // user journal, and the system one for an admin in the adm / systemd-journal group.
    const match = units === "all" ? [`--user-unit=${UNIT_PREFIX}*`] : units.map(u => `--user-unit=${u.unit}`);
    return ["-o", "json", "--no-pager", "-n", String(o.lines), ...match,
        ...(o.errors ? ["-p", "warning"] : []), ...(o.since ? [`--since=${o.since}`] : []), ...(o.follow ? ["-f"] : [])];
}

// One journal JSON entry → a line: time, [process], message. Warnings yellow, errors red.
export function formatJournalLine(json: string, withName: boolean, c = palette()): string | null {
    let e: any;
    try { e = JSON.parse(json); } catch { return null; }
    let msg: string = Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString("utf-8") : String(e.MESSAGE ?? "");
    const us = Number(e.__REALTIME_TIMESTAMP);
    const d = new Date(Number.isFinite(us) ? us / 1000 : Date.now()), p = (n: number, w = 2) => String(n).padStart(w, "0");
    const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const unit = String(e._SYSTEMD_USER_UNIT ?? e.USER_UNIT ?? e.SYSLOG_IDENTIFIER ?? "");
    const name = unit.replace(/\.service$/, "").replace(new RegExp("^" + UNIT_PREFIX), "");
    // systemd's own lines about the unit (Started, Stopped, Main process exited …).
    const fromSystemd = e.SYSLOG_IDENTIFIER === "systemd" || (e._COMM === "systemd" && !e._SYSTEMD_USER_UNIT);
    if (fromSystemd) msg = c.dim("systemd: " + msg);
    const prio = Number(e.PRIORITY);
    if (prio <= 3) msg = c.red(msg); else if (prio === 4) msg = c.yellow(msg);
    return `${c.dim(time)} ${withName ? c.blue(name.padEnd(18)) + " " : ""}${msg}`;
}

export function fmtBytes(b: number | null): string {
    if (b === null) return "—";
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    if (b < 1024 ** 3) return `${Math.round(b / 1024 / 1024)} MB`;
    return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

export function fmtDuration(sec: number | null): string {
    if (sec === null || sec < 0) return "—";
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${Math.floor(sec)}s`;
}

export interface IPsRow {
    id: string; name: string; slot: string; state: string; pid: string; uptime: string;
    restarts: string; mem: string; cpu: string; port: string; boot: string; bad: boolean;
    // From inside the app (control channel); "—" when it has none.
    rpm: string; epm: string; lag: string; heap: string; hot: boolean;
}

// Numbers worth a colour: 5xx answers, an event loop that stalls, a heap near its limit.
export function metricsCells(m: IControlMetrics | undefined): { rpm: string; epm: string; lag: string; heap: string; hot: boolean } {
    if (!m) return { rpm: "—", epm: "—", lag: "—", heap: "—", hot: false };
    const heapPct = m.heapLimit ? m.heapUsed / m.heapLimit * 100 : 0;
    return {
        rpm: String(m.requestsPerMin),
        epm: String(m.errorsPerMin),
        lag: m.loopDelayP99Ms === null ? "—" : `${Math.round(m.loopDelayP99Ms)}ms`,
        heap: `${fmtBytes(m.heapUsed)}${heapPct >= 80 ? ` (${Math.round(heapPct)}%)` : ""}`,
        hot: m.errorsPerMin > 0 || (m.loopDelayP99Ms ?? 0) >= 200 || heapPct >= 80,
    };
}

export function stateText(s: IUnitState | undefined): { text: string; bad: boolean } {
    if (!s) return { text: "unknown", bad: true };
    if (s.activeState === "active" && s.subState === "running") return { text: "online", bad: false };
    if (s.activeState === "activating" && s.subState === "auto-restart") return { text: "restarting", bad: true };
    if (s.activeState === "failed") return { text: s.result === "start-limit-hit" ? "failed (loop)" : "failed", bad: true };
    if (s.activeState === "inactive") return { text: "stopped", bad: false };
    return { text: s.activeState + (s.subState ? "/" + s.subState : ""), bad: s.activeState !== "active" };
}

export function buildRows(units: IUnitInfo[], states: Map<string, IUnitState>, uptimeSec: number | null,
    cpu: Map<string, number>, metrics: Map<string, IControlMetrics> = new Map()): IPsRow[] {
    return units.map(u => {
        const s = states.get(u.unit);
        const st = stateText(s);
        const running = st.text === "online";
        const since = running && s?.activeSinceUs && uptimeSec !== null ? uptimeSec - s.activeSinceUs / 1e6 : null;
        const pct = cpu.get(u.unit);
        return {
            id: u.id === null ? "?" : String(u.id),
            name: u.project ?? u.name,
            slot: u.slot ?? "—",
            state: st.text,
            pid: running && s?.pid ? String(s.pid) : "—",
            uptime: fmtDuration(since),
            restarts: s?.restarts === null || s?.restarts === undefined ? "—" : String(s.restarts),
            mem: running ? fmtBytes(s?.memory ?? null) : "—",
            cpu: running && pct !== undefined ? `${pct.toFixed(1)}%` : "—",
            port: u.port ?? "—",
            boot: s?.enabled ? "✓" : "—",
            bad: st.bad,
            ...metricsCells(running ? metrics.get(u.unit) : undefined),
        };
    });
}

export function renderTable(header: string[], rows: string[][], color?: (row: number, col: number, text: string) => string): string {
    const w = header.map((h, i) => Math.max(h.length, ...rows.map(r => [...r[i]].length)));
    const line = (r: string[], ri: number) => " " + r.map((t, i) => {
        const padded = i === 0 ? t.padStart(w[i]) : t + " ".repeat(w[i] - [...t].length);
        return color && ri >= 0 ? color(ri, i, padded) : padded;
    }).join("  ");
    return [line(header, -1), ...rows.map((r, i) => line(r, i))].join("\n");
}

// ---- side effects ---------------------------------------------------------------------------

export interface IPm2Proc { id: number; name: string; status: string; pid: number | null; restarts: number; memory: number | null; cpu: number | null; uptimeMs: number | null; control?: string | null }

async function pm2List(): Promise<IPm2Proc[] | null> {
    try {
        const r = await execFileAsync("pm2", ["jlist"], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
        const list = JSON.parse(String(r.stdout));
        if (!Array.isArray(list)) return [];
        return list.map((p: any) => ({
            id: Number(p?.pm_id), name: String(p?.name ?? "?"), status: String(p?.pm2_env?.status ?? "?"),
            pid: p?.pid || null, restarts: Number(p?.pm2_env?.restart_time ?? 0),
            memory: typeof p?.monit?.memory === "number" ? p.monit.memory : null,
            cpu: typeof p?.monit?.cpu === "number" ? p.monit.cpu : null,
            uptimeMs: p?.pm2_env?.status === "online" && p?.pm2_env?.pm_uptime ? Date.now() - Number(p.pm2_env.pm_uptime) : null,
            control: typeof p?.pm2_env?.BMFK_CONTROL_SOCKET === "string" ? p.pm2_env.BMFK_CONTROL_SOCKET : null,
        }));
    } catch { return null; }   // no pm2 here
}

function systemUptime(): number | null {
    try { return Number(fs.readFileSync("/proc/uptime", "utf-8").split(" ")[0]); } catch { return null; }
}

export interface IPsDeps {
    systemctl: Systemctl;
    unitDir: string;
    platform: NodeJS.Platform;
    out: (s: string) => void;
    err: (s: string) => void;
    pm2: () => Promise<IPm2Proc[] | null>;
    journal: (args: string[], onLine: (l: string) => void) => Promise<number>;
    user: string;
    exists: (p: string) => boolean;
    read: (p: string) => string | null;
    // One request to an app's control socket (control/Control.ts).
    ask: <T>(socket: string, op: ControlOp, args?: Record<string, unknown>) => Promise<T>;
}

function realJournal(args: string[], onLine: (l: string) => void): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn("journalctl", args, { env: userManagerEnv(), stdio: ["ignore", "pipe", "inherit"] });
        let buf = "";
        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
            buf += chunk;
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
        });
        child.on("error", () => resolve(127));
        child.on("close", (code) => { if (buf) onLine(buf); resolve(code ?? 0); });
        process.once("SIGINT", () => child.kill("SIGTERM"));
    });
}

export function defaultDeps(): IPsDeps {
    return {
        systemctl: realSystemctl,
        unitDir: userUnitDir(),
        platform: process.platform,
        out: (s) => console.log(s),
        err: (s) => console.error(s),
        pm2: pm2List,
        journal: realJournal,
        user: os.userInfo().username,
        exists: (p) => fs.existsSync(p),
        read: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
        ask: (socket, op, args) => controlCall(socket, op, args, 1500),
    };
}

export async function unitStates(systemctl: Systemctl, units: IUnitInfo[]): Promise<Map<string, IUnitState>> {
    if (!units.length) return new Map();
    const out = await systemctl(["show", ...units.map(u => u.unit), ...SHOW_PROPERTIES.map(p => `--property=${p}`)]);
    return parseShow(out);
}
const states = (d: IPsDeps, units: IUnitInfo[]) => unitStates(d.systemctl, units);

const USAGE = [
    "Usage:",
    "  bmfk ps [list]                                      — every process: state, pid, uptime, restarts, memory, cpu, port, boot",
    "  bmfk ps watch [-i 2]                                — the list, live (cpu between frames), until Ctrl+C",
    "  bmfk ps log <id|name|all> [-f] [-n 100] [--errors] [--since 1h]",
    "  bmfk ps show <id|name>                              — unit, paths, state, last exit, recent log",
    "  bmfk ps start|stop|restart <id|name|all>            — stop also keeps it from starting at boot; start undoes that",
    "  bmfk ps loglevel <id|name|all> [level]             — show or change the log level, until the next restart",
    "  bmfk ps startup                                     — what's missing for the processes to start at boot, and the fix",
    "  bmfk ps boot-check                                  — what starts after a reboot",
    "A name is a process (shop-blue) or a project (shop: both slots).",
].join("\n");

export async function Ps(args: string[], d: IPsDeps = defaultDeps()): Promise<number> {
    const c = palette();
    const [sub = "list", ...rest] = args;
    if (sub === "help" || sub === "--help" || sub === "-h") { d.out(USAGE); return 0; }

    const linux = d.platform === "linux";
    if (!linux && sub !== "list") {
        d.err(`bmfk ps ${sub} needs Linux with systemd (this is ${d.platform}). For pm2 processes use pm2 itself.`);
        return 1;
    }
    const units = linux ? listUnits(d.unitDir) : [];

    const pick = (arg: string | undefined, allowAll: boolean): IUnitInfo[] | null => {
        if (!arg) { d.err(`which process? an id or a name from \`bmfk ps list\`${allowAll ? ", or all" : ""}`); return null; }
        const found = resolveTargets(arg, units, allowAll);
        if (!found.length) {
            d.err(`no bmfk process "${arg}" — see \`bmfk ps list\`.`);
            return null;
        }
        return found;
    };

    try {
        switch (sub) {
            case "list": case "ls": return await list(d, units, c, linux);
            case "watch": case "monit": return await watch(d, rest, c);
            case "log": case "logs": return await log(d, units, rest, c);
            case "show": {
                if (rest.length !== 1) { d.err("Usage: bmfk ps show <id|name>"); return 1; }
                const t = pick(rest[0], false); if (!t) return 1;
                return await show(d, t, c);
            }
            case "start": case "stop": case "restart": {
                if (rest.length !== 1) { d.err(`Usage: bmfk ps ${sub} <id|name|all>`); return 1; }
                const t = pick(rest[0], true); if (!t) return 1;
                return await control(d, sub, t, c);
            }
            case "loglevel": {
                if (rest.length < 1 || rest.length > 2) { d.err(`Usage: bmfk ps loglevel <id|name|all> [${LOG_LEVEL_NAMES.join("|")}]`); return 1; }
                const t = pick(rest[0], true); if (!t) return 1;
                return await logLevel(d, t, rest[1], c);
            }
            case "startup": return bootReport(d, units, c, true);
            case "boot-check": return bootReport(d, units, c, false);
            default:
                d.err(`Unknown: bmfk ps ${sub}\n\n${USAGE}`);
                return 1;
        }
    } catch (e: any) {
        const why = String(e?.stderr || e?.message || e).trim();
        d.err(c.red("✗ ") + why);
        if (/Failed to connect to bus|XDG_RUNTIME_DIR|No medium found/i.test(why))
            d.err("  The systemd user manager of this user isn't reachable — log in as this user (not via su/sudo), or run: bmfk ps startup");
        return 1;
    }
}

// Metrics of several apps at once; an app that doesn't answer is just left out.
async function gatherMetrics(d: IPsDeps, sockets: [string, string][]): Promise<Map<string, IControlMetrics>> {
    const out = new Map<string, IControlMetrics>();
    await Promise.all(sockets.map(async ([key, sock]) => {
        try { out.set(key, await d.ask<IControlMetrics>(sock, "metrics")); } catch { }
    }));
    return out;
}

// CPU between two readings, as % of one core. A new pid (restart) has no comparable reading.
export function cpuPercent(first: Map<string, IUnitState>, second: Map<string, IUnitState>, ms: number): Map<string, number> {
    const cpu = new Map<string, number>();
    for (const [k, s] of second) {
        const f = first.get(k), a = f?.cpuNs, b = s.cpuNs;
        if (a !== null && a !== undefined && b !== null && b >= a && f?.pid === s.pid && ms > 0) cpu.set(k, (b - a) / (ms * 1e4));
    }
    return cpu;
}

// The `list` screen. `prev` (with its time) gives CPU without waiting; without it, two readings
// half a second apart. Returns the lines and this reading, for the next frame of `watch`.
async function listLines(d: IPsDeps, units: IUnitInfo[], c: ReturnType<typeof palette>, linux: boolean,
    prev?: { at: number; states: Map<string, IUnitState> }): Promise<{ lines: string[]; reading?: { at: number; states: Map<string, IUnitState> } }> {
    const lines: string[] = [];
    let reading: { at: number; states: Map<string, IUnitState> } | undefined;
    if (linux && units.length) {
        let base = prev;
        if (!base) {
            base = { at: Date.now(), states: await states(d, units) };
            await new Promise(r => setTimeout(r, 500));
        }
        reading = { at: Date.now(), states: await states(d, units) };
        const metrics = await gatherMetrics(d, units.filter(u => u.control && reading!.states.get(u.unit)?.activeState === "active").map(u => [u.unit, u.control!]));
        const rows = buildRows(units, reading.states, systemUptime(), cpuPercent(base.states, reading.states, reading.at - base.at), metrics);
        const header = ["id", "name", "slot", "state", "pid", "uptime", "↺", "mem", "cpu", "req/m", "5xx/m", "lag p99", "heap", "port", "boot"];
        lines.push(renderTable(header, rows.map(r => [r.id, r.name, r.slot, r.state, r.pid, r.uptime, r.restarts, r.mem, r.cpu, r.rpm, r.epm, r.lag, r.heap, r.port, r.boot]),
            (ri, col, t) => col === 3 ? (rows[ri].bad ? c.red(t) : rows[ri].state === "online" ? c.green(t) : c.dim(t))
                : col >= 10 && col <= 12 && rows[ri].hot ? c.yellow(t) : t));
    } else if (linux) {
        lines.push(c.dim("No bmfk processes under systemd yet (projects with \"runner\": \"systemd\" appear here after their first deploy)."));
    } else {
        lines.push(c.dim(`systemd processes: none on ${d.platform}.`));
    }

    const pm2 = await d.pm2();
    if (pm2 && pm2.length) {
        lines.push("");
        lines.push(c.bold("pm2") + c.dim("  — manage with pm2 (pm2 logs <name>, pm2 restart <name>)"));
        const pm = await gatherMetrics(d, pm2.filter(p => p.control && p.status === "online").map(p => [String(p.id), p.control!]));
        const header = ["pm2 id", "name", "state", "pid", "uptime", "↺", "mem", "cpu", "req/m", "5xx/m", "lag p99", "heap"];
        lines.push(renderTable(header, pm2.map(p => { const m = metricsCells(pm.get(String(p.id))); return [String(p.id), p.name, p.status, p.pid ? String(p.pid) : "—",
            fmtDuration(p.uptimeMs === null ? null : p.uptimeMs / 1000), String(p.restarts), fmtBytes(p.memory), p.cpu === null ? "—" : `${p.cpu}%`, m.rpm, m.epm, m.lag, m.heap]; }),
            (ri, col, t) => col === 2 ? (pm2[ri].status === "online" ? c.green(t) : c.red(t)) : t));
    }
    return { lines, reading };
}

async function list(d: IPsDeps, units: IUnitInfo[], c: ReturnType<typeof palette>, linux: boolean): Promise<number> {
    for (const l of (await listLines(d, units, c, linux)).lines) d.out(l);
    return 0;
}

// `list`, redrawn every few seconds until Ctrl+C. Units are re-read each frame: a deploy that adds
// a process shows up without restarting watch.
async function watch(d: IPsDeps, args: string[], c: ReturnType<typeof palette>): Promise<number> {
    let seconds = 2;
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "-i" || args[i] === "--interval") && /^[0-9]{1,3}$/.test(args[i + 1] ?? "") && Number(args[i + 1]) >= 1) seconds = Number(args[++i]);
        else { d.err("Usage: bmfk ps watch [-i seconds]"); return 1; }
    }
    let stop = false;
    process.once("SIGINT", () => { stop = true; });
    let prev: { at: number; states: Map<string, IUnitState> } | undefined;
    const tty = !!process.stdout.isTTY;
    while (!stop) {
        const r = await listLines(d, listUnits(d.unitDir), c, true, prev);
        prev = r.reading;
        const head = c.dim(`bmfk ps watch — every ${seconds}s, Ctrl+C to quit · ${new Date().toLocaleTimeString()}`);
        d.out((tty ? "\x1b[2J\x1b[H" : "") + [head, "", ...r.lines].join("\n"));
        for (let t = 0; t < seconds * 10 && !stop; t++) await new Promise(res => setTimeout(res, 100));
    }
    return 0;
}

async function log(d: IPsDeps, units: IUnitInfo[], args: string[], c: ReturnType<typeof palette>): Promise<number> {
    const parsed = parseLogArgs(args);
    if (parsed.error) { d.err(parsed.error + "\nUsage: bmfk ps log <id|name|all> [-f] [-n 100] [--errors] [--since 1h]"); return 1; }
    const target = parsed.target!, o = parsed.opts!;
    let selected: IUnitInfo[] | "all";
    if (target === "all") selected = "all";
    else {
        const found = resolveTargets(target, units, false);
        if (!found.length) {
            const pm2 = await d.pm2();
            if (pm2?.some(p => p.name === target || String(p.id) === target))
                d.err(`"${target}" runs under pm2 — its log: pm2 logs ${target}`);
            else d.err(`no bmfk process "${target}" — see \`bmfk ps list\`.`);
            return 1;
        }
        selected = found;
    }
    const withName = selected === "all" || selected.length > 1;
    let shown = 0;
    const code = await d.journal(journalArgs(selected, o), (l) => {
        const line = formatJournalLine(l, withName, c);
        if (line !== null) { shown++; d.out(line); }
    });
    if (code === 127) { d.err("journalctl not found."); return 1; }
    if (!shown && !o.follow)
        d.err(c.dim("No log lines. If the process has run, the journal may keep user logs only in memory, or in the system journal — see `bmfk ps startup`."));
    return code === 0 || o.follow ? 0 : code;
}

async function show(d: IPsDeps, targets: IUnitInfo[], c: ReturnType<typeof palette>): Promise<number> {
    const st = await states(d, targets);
    for (const u of targets) {
        const s = st.get(u.unit);
        const text = d.read(u.file) ?? "";
        const get = (k: string) => (text.match(new RegExp("^" + k + "=(.*)$", "m"))?.[1] ?? "—").trim();
        const state = stateText(s);
        d.out(c.bold(`${u.id ?? "?"}  ${u.name}`) + "  " + (state.bad ? c.red(state.text) : c.green(state.text)));
        const rows: [string, string][] = [
            ["unit", u.unit], ["unit file", u.file], ["project", u.project ?? "—"], ["slot", u.slot ?? "—"], ["port", u.port ?? "—"],
            ["folder", get("WorkingDirectory")], ["command", get("ExecStart")],
            ["pid", s?.pid ? String(s.pid) : "—"], ["restarts", s?.restarts === null || !s ? "—" : String(s.restarts)],
            ["memory", fmtBytes(s?.memory ?? null) + (s?.memoryPeak ? c.dim(`  (peak ${fmtBytes(s.memoryPeak)})`) : "")],
            ["memory limits", `high ${get("MemoryHigh")}, max ${get("MemoryMax")}`],
            ["threads", s?.tasks === null || !s ? "—" : String(s.tasks)],
            ["disk i/o", s?.ioRead === null && s?.ioWrite === null || !s ? "—" : `read ${fmtBytes(s.ioRead)}, written ${fmtBytes(s.ioWrite)}`],
            ["last result", s?.result ? `${s.result}${s.exitStatus && s.exitStatus !== "0" ? ` (exit status ${s.exitStatus})` : ""}` : "—"],
            ["starts at boot", s?.enabled ? "yes" : "no"],
            ["sandbox", /^ProtectSystem=strict$/m.test(text) ? "yes" : "no"],
        ];
        for (const [k, v] of rows) d.out(`  ${c.dim(k.padEnd(15))} ${v}`);
        for (const l of await insideLines(d, u, c)) d.out(l);
        d.out(c.dim("  recent log:"));
        await d.journal(journalArgs([u], { follow: false, lines: 15, errors: false, since: null }), (l) => {
            const line = formatJournalLine(l, false, c); if (line !== null) d.out("    " + line);
        });
        d.out("");
    }
    return 0;
}

// What the app says about itself over the control channel: version, live, log level, load, readiness.
async function insideLines(d: IPsDeps, u: IUnitInfo, c: ReturnType<typeof palette>): Promise<string[]> {
    const row = (k: string, v: string) => `  ${c.dim(k.padEnd(15))} ${v}`;
    if (!u.control) return [row("inside the app", c.dim("no control channel (deployed before 1.2.0)"))];
    try {
        const [ping, m, ready] = await Promise.all([
            d.ask<IControlPing>(u.control, "ping"), d.ask<IControlMetrics>(u.control, "metrics"), d.ask<IControlReady>(u.control, "ready")]);
        const out = [
            row("app", `@bmfk/api ${ping.version}, node ${ping.node}, up ${fmtDuration(ping.uptimeSec)}`),
            row("live", ping.live === null ? "unknown" : ping.live ? c.green("yes") : "no (standby)"),
            row("log level", ping.logLevel),
            row("requests", `${m.requestsPerMin}/min, 5xx ${m.errorsPerMin}/min, in progress ${m.inFlight}, connections ${m.connections ?? "—"}`),
            row("event loop", m.loopDelayP99Ms === null ? "—" : `delay p99 ${m.loopDelayP99Ms} ms, mean ${m.loopDelayMeanMs} ms, busy ${m.loopUtilizationPct}%`),
            row("heap", `${fmtBytes(m.heapUsed)} of ${fmtBytes(m.heapLimit)}, rss ${fmtBytes(m.rss)}`),
            row("ready", ready.ready ? c.green("yes") : c.red("no")),
        ];
        for (const ch of ready.checks)
            out.push(row("", `${ch.ok ? c.green("✓") : c.red("✗")} ${ch.name} ${c.dim(ch.ms + " ms")}${ch.detail ? " — " + ch.detail : ""}`));
        return out;
    } catch (e: any) {
        return [row("inside the app", c.yellow(String(e?.message ?? e)))];
    }
}

// bmfk ps loglevel <id|name|all> [level]: show or change the log level, without a restart. Until the
// next restart: the app's own options decide after that.
async function logLevel(d: IPsDeps, targets: IUnitInfo[], level: string | undefined, c: ReturnType<typeof palette>): Promise<number> {
    if (level !== undefined && !(LOG_LEVEL_NAMES as readonly string[]).includes(level)) {
        d.err(`level must be one of ${LOG_LEVEL_NAMES.join(", ")}`);
        return 1;
    }
    let failed = 0;
    for (const u of targets) {
        if (!u.control) { failed++; d.err(`${c.red("✗")} ${u.name}: no control channel (deployed before 1.2.0)`); continue; }
        try {
            const r = await d.ask<{ level: string; before?: string }>(u.control, "loglevel", level ? { level } : undefined);
            d.out(level ? `${c.green("✓")} ${u.name}: ${r.before} → ${r.level} ${c.dim("(until the next restart)")}` : `  ${u.name}: ${r.level}`);
        } catch (e: any) {
            failed++;
            d.err(`${c.red("✗")} ${u.name}: ${String(e?.message ?? e)}`);
        }
    }
    return failed ? 1 : 0;
}

async function control(d: IPsDeps, action: "start" | "stop" | "restart", targets: IUnitInfo[], c: ReturnType<typeof palette>): Promise<number> {
    let failed = 0;
    for (const u of targets) {
        try {
            if (action === "stop") {
                await d.systemctl(["stop", u.unit]);
                await d.systemctl(["disable", u.unit]);
            } else {
                await d.systemctl(["reset-failed", u.unit]).catch(() => "");
                if (action === "start") await d.systemctl(["enable", u.unit]);
                await d.systemctl([action, u.unit]);
            }
            d.out(`${c.green("✓")} ${action === "stop" ? "stopped (won't start at boot)" : action === "start" ? "started (starts at boot)" : "restarted"}  ${u.id ?? "?"} ${u.name}`);
        } catch (e: any) {
            failed++;
            d.err(`${c.red("✗")} ${action} ${u.name}: ${String(e?.stderr || e?.message || e).trim()}`);
        }
    }
    return failed ? 1 : 0;
}

// Boot readiness: linger (the user manager starts without a login), persistent journal, the
// manager reachable, and which units are enabled. startup = the same plus the commands to fix.
async function bootReport(d: IPsDeps, units: IUnitInfo[], c: ReturnType<typeof palette>, fixes: boolean): Promise<number> {
    const problems: { what: string; fix: string }[] = [];
    const ok = (t: string) => d.out(`  ${c.green("✓")} ${t}`);
    const bad = (t: string, fix: string) => { d.out(`  ${c.red("✗")} ${t}`); problems.push({ what: t, fix }); };

    d.out(c.bold(`Boot check for user ${d.user}`));
    if (d.exists(`/var/lib/systemd/linger/${d.user}`)) ok("linger on — the user's services start at boot, without a login");
    else bad("linger off — the user's services start only when the user logs in", `sudo loginctl enable-linger ${d.user}`);

    let reachable = true;
    try { await d.systemctl(["is-system-running"]); ok("systemd user manager reachable"); }
    catch (e: any) {
        // is-system-running exits non-zero for "degraded" too; that still means it answered.
        if (String(e?.stdout ?? "").trim()) ok(`systemd user manager reachable (${String(e.stdout).trim()})`);
        else { reachable = false; bad("systemd user manager not reachable", `log in as ${d.user} directly (ssh), not via su/sudo; with linger on it runs from boot`); }
    }

    // The projects' sandbox (ProtectSystem, PrivateTmp … in a user unit) needs user namespaces.
    const sysctl = (p: string) => (d.read(p) ?? "").trim();
    if (sysctl("/proc/sys/user/max_user_namespaces") === "0" || sysctl("/proc/sys/kernel/unprivileged_userns_clone") === "0")
        bad("user namespaces off — units with the sandbox (the default) won't start",
            `sudo sysctl -w kernel.unprivileged_userns_clone=1 (and the same in /etc/sysctl.d/), or "systemd": { "sandbox": false } in the project config`);
    else if (sysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1")
        d.out(`  ${c.yellow("!")} AppArmor restricts user namespaces — if a unit fails at start with a "namespace" error, set "systemd": { "sandbox": false } for that project`);
    else ok("user namespaces available — the projects' sandbox can work");

    const conf = d.read("/etc/systemd/journald.conf") ?? "";
    const volatile = /^\s*Storage\s*=\s*(volatile|none)\s*$/m.test(conf);
    if (!volatile && d.exists("/var/log/journal")) ok("journal kept on disk — logs survive a reboot");
    else bad("journal kept in memory only — logs are lost at reboot",
        volatile ? "set Storage=persistent in /etc/systemd/journald.conf, then: sudo systemctl restart systemd-journald"
            : "sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create --prefix /var/log/journal && sudo systemctl restart systemd-journald");

    if (reachable && units.length) {
        const st = await states(d, units);
        const on = units.filter(u => st.get(u.unit)?.enabled), off = units.filter(u => !st.get(u.unit)?.enabled);
        d.out("");
        d.out(c.bold("After a reboot"));
        for (const u of on) d.out(`  ${c.green("✓")} ${String(u.id ?? "?").padStart(3)}  ${u.name}`);
        for (const u of off) d.out(`  ${c.dim("—")} ${String(u.id ?? "?").padStart(3)}  ${u.name}  ${c.dim("(stopped with bmfk ps stop — `bmfk ps start " + u.name + "` brings it back)")}`);
    } else if (reachable) {
        d.out(c.dim("\n  No bmfk processes under systemd yet."));
    }

    if (problems.length && fixes) {
        d.out("");
        d.out(c.bold("To fix") + c.dim(" (run as an admin; bmfk never runs sudo itself):"));
        for (const p of problems) d.out(`  ${p.fix}`);
    } else if (problems.length) {
        d.out(c.dim("\n  `bmfk ps startup` prints the commands to fix this."));
    }
    return problems.length ? 1 : 0;
}
