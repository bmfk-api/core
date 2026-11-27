// The app's side of the control channel (see Control.ts): listens on BMFK_CONTROL_SOCKET when the
// deployer set it. Started by APIService; nothing to do in the app's own code.

import fs from "fs";
import net from "net";
import path from "path";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import v8 from "v8";
import { CONTROL_OPS, CONTROL_PROTOCOL, CONTROL_SOCKET_ENV, ControlOp, IControlMetrics, IControlPing, LOG_LEVEL_NAMES, MAX_LINE, MAX_SOCKET_PATH, lineReader } from "./Control";
import { runReadinessChecks } from "./ReadinessChecks";
import { LOG_LEVEL, REQ_CURRENT_LOG_LEVEL, S_LOG_CHANGE_LEVEL, logInfo, logWarn } from "../LogService";
import { getBlueGreenActiveState, getBlueGreenStateSync } from "../deployment/BlueGreenState";
import { S_STAT_REGISTRATE_REQUEST } from "../MonitorService";
import { AppData } from "../helper/AppDataPath";

const LEVELS: Record<string, LOG_LEVEL> = {
    all: LOG_LEVEL.ALL, api: LOG_LEVEL.API, info: LOG_LEVEL.INFO, db: LOG_LEVEL.DB,
    warn: LOG_LEVEL.WARN, error: LOG_LEVEL.ERROR, crit: LOG_LEVEL.CRIT,
};
const levelName = (l: LOG_LEVEL) => Object.keys(LEVELS).find(k => LEVELS[k] === l) ?? String(l);

const MAX_CONNECTIONS = 16;
const IDLE_MS = 10_000;

export interface IControlContext {
    version: string;
    inFlight: () => number;
    connections: () => Promise<number | null>;
}

// Requests per second over the last minute, in a ring.
class RequestCounter {
    private sec = new Array<number>(60).fill(0);
    private err = new Array<number>(60).fill(0);
    private at = Math.floor(Date.now() / 1000);
    private readonly startedAt = Date.now();

    private roll(now: number) {
        const s = Math.floor(now / 1000);
        for (let t = this.at + 1; t <= s && t <= this.at + 60; t++) { this.sec[t % 60] = 0; this.err[t % 60] = 0; }
        this.at = Math.max(this.at, s);
    }
    add(status: number, now = Date.now()) {
        this.roll(now);
        const i = Math.floor(now / 1000) % 60;
        this.sec[i]++;
        if (status >= 500) this.err[i]++;
    }
    perMinute(now = Date.now()): { requests: number; errors: number } {
        this.roll(now);
        const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
        const secs = Math.min(60, Math.max(1, (now - this.startedAt) / 1000));
        const k = 60 / secs;
        return { requests: Math.round(sum(this.sec) * k), errors: Math.round(sum(this.err) * k) };
    }
}

export class ControlServer {
    private server: net.Server | null = null;
    private socketPath: string | null = null;
    private requests = new RequestCounter();
    private loop = monitorEventLoopDelay({ resolution: 10 });
    private loopWindow: { p99: number | null; mean: number | null; elu: number | null } = { p99: null, mean: null, elu: null };
    private eluPrev = performance.eventLoopUtilization();
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly ctx: IControlContext) { }

    // Starts listening when the deployer asked for it. Never throws: the app runs without the channel.
    start(env: NodeJS.ProcessEnv = process.env): string | null {
        const p = env[CONTROL_SOCKET_ENV];
        if (!p) return null;
        // pm2 cluster: one socket per process name; instance 0 answers.
        if (env.NODE_APP_INSTANCE && env.NODE_APP_INSTANCE !== "0") return null;
        if (!path.isAbsolute(p) || Buffer.byteLength(p) > MAX_SOCKET_PATH) {
            logWarn(`Control channel off: ${CONTROL_SOCKET_ENV} must be an absolute path of at most ${MAX_SOCKET_PATH} bytes`);
            return null;
        }
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
            // A socket left by a crashed process: nobody answers on it, so it goes.
            if (fs.existsSync(p)) {
                if (!fs.lstatSync(p).isSocket()) { logWarn(`Control channel off: ${p} exists and is not a socket`); return null; }
                fs.unlinkSync(p);
            }
        } catch (e: any) {
            logWarn(`Control channel off: ${e?.message ?? e}`);
            return null;
        }

        S_STAT_REGISTRATE_REQUEST.subscribe(r => this.requests.add(r?.error ? (r.httpStatus ?? 500) : (r?.httpStatus ?? 200)));
        this.loop.enable();
        this.timer = setInterval(() => this.sampleLoop(), 10_000);
        this.timer.unref();

        const server = net.createServer({ allowHalfOpen: false }, (conn) => this.onConnection(conn));
        server.maxConnections = MAX_CONNECTIONS;
        server.on("error", (e: any) => logWarn(`Control channel: ${e?.message ?? e}`));
        // The socket is created by listen(); the umask keeps it 0600 from its first moment.
        const old = process.umask(0o177);
        try { server.listen(p); } finally { process.umask(old); }
        server.unref();
        this.server = server;
        this.socketPath = p;
        logInfo(`Control channel at ${p}`);
        return p;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.loop.disable();
        this.server?.close();
        if (this.socketPath) { try { fs.unlinkSync(this.socketPath); } catch { } }
        this.server = null;
    }

    private sampleLoop() {
        const ns = (v: number) => Number.isFinite(v) && v > 0 && v < 3.6e12 ? Math.round(v / 1e4) / 100 : null;
        const cur = performance.eventLoopUtilization();
        const d = performance.eventLoopUtilization(cur, this.eluPrev);
        this.eluPrev = cur;
        this.loopWindow = { p99: ns(this.loop.percentile(99)), mean: ns(this.loop.mean), elu: Math.round(d.utilization * 1000) / 10 };
        this.loop.reset();
    }

    private onConnection(conn: net.Socket) {
        conn.setTimeout(IDLE_MS, () => conn.destroy());
        conn.on("error", () => { });
        conn.on("data", lineReader(
            (line) => { void this.handle(line).then(r => { if (!conn.destroyed) conn.write(JSON.stringify(r) + "\n"); }); },
            () => { conn.write(JSON.stringify({ v: CONTROL_PROTOCOL, id: null, ok: false, error: `line over ${MAX_LINE} bytes` }) + "\n"); conn.destroy(); }));
    }

    // One request line → one response. Exported for tests through handleLine.
    async handle(line: string): Promise<Record<string, unknown>> {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return { v: CONTROL_PROTOCOL, id: null, ok: false, error: "not JSON" }; }
        const id = typeof msg?.id === "number" || typeof msg?.id === "string" ? msg.id : null;
        const fail = (error: string) => ({ v: CONTROL_PROTOCOL, id, ok: false, error });
        if (msg?.v !== CONTROL_PROTOCOL) return fail(`protocol ${CONTROL_PROTOCOL} only`);
        if (!(CONTROL_OPS as readonly string[]).includes(msg?.op)) return fail(`unknown operation ${JSON.stringify(msg?.op)}`);
        try {
            return { v: CONTROL_PROTOCOL, id, ok: true, data: await this.op(msg.op as ControlOp, msg.args ?? {}) };
        } catch (e: any) {
            return fail(String(e?.message ?? e));
        }
    }

    private async op(op: ControlOp, args: any): Promise<unknown> {
        switch (op) {
            case "ping": {
                const bg = getBlueGreenStateSync();
                const r: IControlPing = {
                    pid: process.pid, project: bg?.project ?? AppData.project(), slot: bg?.slot ?? null,
                    version: this.ctx.version, node: process.version, uptimeSec: Math.round(process.uptime()),
                    live: bg?.live ?? null, logLevel: levelName(await REQ_CURRENT_LOG_LEVEL.request()),
                };
                return r;
            }
            case "metrics": {
                const m = process.memoryUsage(), per = this.requests.perMinute();
                const r: IControlMetrics = {
                    requestsPerMin: per.requests, errorsPerMin: per.errors,
                    inFlight: this.ctx.inFlight(), connections: await this.ctx.connections(),
                    loopDelayP99Ms: this.loopWindow.p99, loopDelayMeanMs: this.loopWindow.mean, loopUtilizationPct: this.loopWindow.elu,
                    heapUsed: m.heapUsed, heapLimit: v8.getHeapStatistics().heap_size_limit, rss: m.rss,
                };
                return r;
            }
            case "ready":
                return runReadinessChecks();
            case "refresh-live": {
                // The deployer just switched slots: ask it now instead of at the next poll. The answer
                // comes from the deployer's state, not from this message.
                const s = await getBlueGreenActiveState({ force: true });
                return { live: s.live, bluegreen: s.bluegreen, slot: s.slot, active: s.active };
            }
            case "loglevel": {
                const name = args?.level;
                const before = levelName(await REQ_CURRENT_LOG_LEVEL.request());
                if (name === undefined) return { level: before };
                if (typeof name !== "string" || !(LOG_LEVEL_NAMES as readonly string[]).includes(name))
                    throw new Error(`level must be one of ${LOG_LEVEL_NAMES.join(", ")}`);
                S_LOG_CHANGE_LEVEL.invoke(LEVELS[name]);
                logWarn(`Log level ${before} → ${name} (control channel)`);
                return { level: name, before };
            }
        }
    }
}
