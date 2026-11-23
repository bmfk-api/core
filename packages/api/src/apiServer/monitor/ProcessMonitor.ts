// Process-level observability for the running Node app.
// Complements SystemInfo (which is OS-wide) — here everything is scoped to THIS process.
//
// All probes are cheap built-ins:
//   - process.* / os.* / v8.* — synchronous, microsecond cost
//   - perf_hooks.monitorEventLoopDelay() — C++-side histogram, designed for production
//   - PerformanceObserver({entryTypes:["gc"]}) — fires inline after GC, negligible overhead
//   - /proc/<pid>/* — small files, read async with fs.promises
//
// Two background samplers (CPU + Event Loop Utilization) run every 5s on unref'd timers,
// so they never keep the event loop alive on their own.

import os from "os";
import v8 from "v8";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "perf_hooks";
import fs from "fs/promises";

type ELDHistogram = ReturnType<typeof monitorEventLoopDelay>;

type CpuPctSnapshot = { userPct: number; systemPct: number };
type ELUSnapshot = { idle: number; active: number; utilizationPct: number };

type GcAccumulator = {
    totalCount: number;
    totalTimeMs: number;
    maxPauseMs: number;
    byKind: Record<string, { count: number; timeMs: number }>;
    lastPauses: Array<{ kind: string; ms: number; timestamp: number }>;
};

export class ProcessMonitor {
    private static _inited = false;

    private static _eld: ELDHistogram | null = null;
    private static _gcObserver: PerformanceObserver | null = null;

    private static _gc: GcAccumulator = {
        totalCount: 0,
        totalTimeMs: 0,
        maxPauseMs: 0,
        byKind: {},
        lastPauses: [],
    };

    private static _prevCpu = process.cpuUsage();
    private static _prevCpuAt = Date.now();
    private static _cpuPct: CpuPctSnapshot = { userPct: 0, systemPct: 0 };

    private static _eluPrev = performance.eventLoopUtilization();
    private static _elu: ELUSnapshot = { idle: 0, active: 0, utilizationPct: 0 };

    private static _processStartedAt = Date.now() - process.uptime() * 1000;

    // --- fd / socket time series ---------------------------------------------------------------
    // Ring buffer of periodic samples so we can SEE the trend over hours/days — the whole point of
    // hunting a slow fd/socket leak. Each sample is tiny; default 10-min cadence keeps ~300 samples
    // (~2 days). Override the interval with env MONITOR_FD_SAMPLE_MINUTES.
    private static _fdHistory: Array<{
        ts: number;
        fdOpen: number | null;
        fdSoftLimit: number | null;
        socketTotal: number | null;
        byState: Record<string, number>;
        topRemote: { host: string; established: number } | null;
        rss: number;
    }> = [];
    private static _fdHistoryMax = 300;
    private static _fdSampleEveryMs =
        Math.max(1, parseInt(process.env.MONITOR_FD_SAMPLE_MINUTES || "10", 10) || 10) * 60 * 1000;

    static init() {
        if (this._inited) return;
        this._inited = true;

        // Event loop delay histogram — resolution 20ms is fine (cheap, captures stalls down to ~20ms).
        this._eld = monitorEventLoopDelay({ resolution: 20 });
        this._eld.enable();

        // GC observer — accumulates count/duration per GC kind + ring of recent pauses.
        this._gcObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const kind = this._mapGcKind((entry as any).detail?.kind ?? (entry as any).kind);
                this._gc.totalCount++;
                this._gc.totalTimeMs += entry.duration;
                if (entry.duration > this._gc.maxPauseMs) this._gc.maxPauseMs = entry.duration;
                const bucket = this._gc.byKind[kind] ?? { count: 0, timeMs: 0 };
                bucket.count++;
                bucket.timeMs += entry.duration;
                this._gc.byKind[kind] = bucket;
                this._gc.lastPauses.push({ kind, ms: entry.duration, timestamp: Date.now() });
                if (this._gc.lastPauses.length > 20) this._gc.lastPauses.shift();
            }
        });
        try {
            this._gcObserver.observe({ entryTypes: ["gc"], buffered: false });
        } catch {
            // older Node versions might require type:"gc" — try fallback
            try { (this._gcObserver as any).observe({ type: "gc" }); } catch {}
        }

        // CPU sampler — diff process.cpuUsage() over 5s window
        const cpuTimer = setInterval(() => this._sampleCpu(), 5000);
        if ((cpuTimer as any).unref) (cpuTimer as any).unref();

        // Event Loop Utilization sampler — diff between snapshots
        const eluTimer = setInterval(() => this._sampleELU(), 5000);
        if ((eluTimer as any).unref) (eluTimer as any).unref();

        // fd/socket time-series sampler — take one immediately, then on the configured cadence.
        // Unref'd so it never keeps the process alive; errors are swallowed (Linux-only probes).
        this._sampleFdSeries().catch(() => {});
        const fdTimer = setInterval(() => this._sampleFdSeries().catch(() => {}), this._fdSampleEveryMs);
        if ((fdTimer as any).unref) (fdTimer as any).unref();
    }

    private static async _sampleFdSeries() {
        const fdOpen = await this._countFds();
        const sockets = await this._readSocketBreakdown();
        const limits = await this._readProcLimits();
        const softRaw = limits?.["Max open files"]?.soft;
        const mem = process.memoryUsage();
        this._fdHistory.push({
            ts: Date.now(),
            fdOpen,
            fdSoftLimit: softRaw ? this._parseLimitValue(softRaw) : null,
            socketTotal: sockets ? sockets.total : null,
            byState: sockets ? sockets.byState : {},
            topRemote: sockets && sockets.topRemotes.length > 0 ? sockets.topRemotes[0] : null,
            rss: mem.rss,
        });
        if (this._fdHistory.length > this._fdHistoryMax) this._fdHistory.shift();
    }

    private static _sampleCpu() {
        const now = process.cpuUsage();
        const nowAt = Date.now();
        const dtMs = nowAt - this._prevCpuAt;
        if (dtMs <= 0) return;
        // process.cpuUsage() returns microseconds. % of one core = micros / (dtMs*1000) * 100.
        const userPct = (now.user - this._prevCpu.user) / (dtMs * 1000) * 100;
        const systemPct = (now.system - this._prevCpu.system) / (dtMs * 1000) * 100;
        this._cpuPct = {
            userPct: Math.round(userPct * 10) / 10,
            systemPct: Math.round(systemPct * 10) / 10,
        };
        this._prevCpu = now;
        this._prevCpuAt = nowAt;
    }

    private static _sampleELU() {
        const cur = performance.eventLoopUtilization();
        const delta = performance.eventLoopUtilization(cur, this._eluPrev);
        this._elu = {
            idle: delta.idle,
            active: delta.active,
            utilizationPct: Math.round(delta.utilization * 10000) / 100,
        };
        this._eluPrev = cur;
    }

    private static _mapGcKind(kind: number | string | undefined): string {
        if (typeof kind === "string") return kind;
        switch (kind) {
            case 1: return "minor";
            case 2: return "major";
            case 4: return "incremental";
            case 8: return "weakcb";
            case 15: return "all";
            default: return "unknown";
        }
    }

    // ---- public snapshot ----

    static async getSnapshot() {
        // One-shot event-loop lag — single setImmediate roundtrip, captures "right now" lag.
        const tStart = process.hrtime.bigint();
        await new Promise<void>(r => setImmediate(() => r()));
        const spotLagMs = Number(process.hrtime.bigint() - tStart) / 1e6;

        const mem = process.memoryUsage();
        const heap = v8.getHeapStatistics();
        const heapSpaces = v8.getHeapSpaceStatistics().map(s => ({
            name: s.space_name,
            size: s.space_size,
            used: s.space_used_size,
            available: s.space_available_size,
            physical: s.physical_space_size,
        }));

        const procStatus = await this._readProcStatus();
        const io = await this._readProcIo();
        const limitsParsed = await this._readProcLimits();

        const cpuTotal = process.cpuUsage();
        let resource: any = null;
        try {
            const r = process.resourceUsage();
            resource = {
                maxRSS: r.maxRSS,
                voluntaryContextSwitches: r.voluntaryContextSwitches,
                involuntaryContextSwitches: r.involuntaryContextSwitches,
                fsRead: r.fsRead,
                fsWrite: r.fsWrite,
                signalsCount: r.signalsCount,
                ipcSent: r.ipcSent,
                ipcReceived: r.ipcReceived,
                userCPUTimeMs: Math.round(r.userCPUTime / 1000),
                systemCPUTimeMs: Math.round(r.systemCPUTime / 1000),
            };
        } catch {}

        const fdOpen = await this._countFds();
        const fdSoft = limitsParsed?.["Max open files"]?.soft;
        const fdHard = limitsParsed?.["Max open files"]?.hard;
        const sockets = await this._readSocketBreakdown();

        const h = this._eld;
        const eventLoop = h ? {
            minMs: this._toMsFinite(h.min),
            maxMs: this._toMsFinite(h.max),
            meanMs: this._toMsFinite(h.mean),
            stddevMs: this._toMsFinite(h.stddev),
            p50Ms: this._safePercentileMs(h, 50),
            p90Ms: this._safePercentileMs(h, 90),
            p99Ms: this._safePercentileMs(h, 99),
            utilizationPct: this._elu.utilizationPct,
            activeHandles: this._safeCount(() => (process as any)._getActiveHandles?.()?.length),
            activeRequests: this._safeCount(() => (process as any)._getActiveRequests?.()?.length),
            spotLagMs: Math.round(spotLagMs * 100) / 100,
        } : null;

        return {
            identity: {
                pid: process.pid,
                ppid: process.ppid,
                title: process.title,
                argv: process.argv,
                execPath: process.execPath,
                cwd: process.cwd(),
                nodeVersion: process.version,
                v8Version: process.versions.v8,
                platform: process.platform,
                arch: process.arch,
                hostname: os.hostname(),
                user: typeof process.getuid === "function"
                    ? { uid: process.getuid(), gid: process.getgid?.() ?? -1 }
                    : null,
                startedAtUnix: this._processStartedAt,
                uptimeSec: Math.round(process.uptime()),
                availableParallelism: typeof os.availableParallelism === "function"
                    ? os.availableParallelism()
                    : os.cpus().length,
                pm2: this.getPm2Identity(),
            },
            memory: {
                rss: mem.rss,
                heapTotal: mem.heapTotal,
                heapUsed: mem.heapUsed,
                external: mem.external,
                arrayBuffers: (mem as any).arrayBuffers ?? 0,
                heap: {
                    sizeLimit: heap.heap_size_limit,            // OOM ceiling
                    usedHeap: heap.used_heap_size,
                    totalAvailable: heap.total_available_size,
                    totalPhysical: heap.total_physical_size,
                    mallocedMemory: heap.malloced_memory,
                    peakMallocedMemory: heap.peak_malloced_memory,
                    numberOfNativeContexts: heap.number_of_native_contexts,
                    numberOfDetachedContexts: heap.number_of_detached_contexts,  // >0 = leak signal
                },
                heapSpaces,
                procStatus,
            },
            cpu: {
                userPct: this._cpuPct.userPct,
                systemPct: this._cpuPct.systemPct,
                userMicros: cpuTotal.user,
                systemMicros: cpuTotal.system,
                resource,
            },
            eventLoop,
            gc: {
                totalCount: this._gc.totalCount,
                totalTimeMs: Math.round(this._gc.totalTimeMs * 100) / 100,
                maxPauseMs: Math.round(this._gc.maxPauseMs * 100) / 100,
                byKind: this._gc.byKind,
                lastPauses: this._gc.lastPauses.slice(-20),
            },
            fileDescriptors: {
                open: fdOpen,
                limitSoft: fdSoft ? this._parseLimitValue(fdSoft) : null,
                limitHard: fdHard ? this._parseLimitValue(fdHard) : null,
            },
            sockets,
            io,
            limits: limitsParsed,
        };
    }

    // ---- pm2 identity ------------------------------------------------------------------------
    // PM2 injects these env vars into every managed child (fork + cluster). Presence of `pm_id`
    // is the reliable "we are supervised" signal; `name` is the app name (e.g. "<proj>-blue" in a
    // blue-green setup). `managed=false` means nothing would respawn us if we exit.
    static getPm2Identity(): {
        managed: boolean;
        name: string | null;
        pmId: string | null;
        instanceId: string | null;
        execPath: string | null;
        cwd: string | null;
    } {
        const env = process.env;
        const pmId = env.pm_id ?? null;
        return {
            managed: pmId !== null && pmId !== "",
            name: env.name ?? null,
            pmId,
            instanceId: env.NODE_APP_INSTANCE ?? null,   // cluster instance index, null in fork mode
            execPath: env.pm_exec_path ?? null,
            cwd: env.pm_cwd ?? null,
        };
    }

    // ---- fd / socket leak report -------------------------------------------------------------
    // One call for the front-end: current picture + the time series. Compare fdOpen against
    // limitSoft (if they converge → fd exhaustion incoming), watch byState.CLOSE_WAIT climbing
    // (server not closing peer-closed sockets) and topRemotes ESTAB piling on one host (hung
    // outgoing keepalive to a gateway).
    static async getFdReport() {
        const [sockets, limits, fdOpen] = await Promise.all([
            this._readSocketBreakdown(),
            this._readProcLimits(),
            this._countFds(),
        ]);
        const softRaw = limits?.["Max open files"]?.soft;
        const hardRaw = limits?.["Max open files"]?.hard;
        return {
            now: {
                ts: Date.now(),
                fdOpen,
                limitSoft: softRaw ? this._parseLimitValue(softRaw) : null,
                limitHard: hardRaw ? this._parseLimitValue(hardRaw) : null,
                sockets,
            },
            sampleEveryMs: this._fdSampleEveryMs,
            historyMax: this._fdHistoryMax,
            history: this._fdHistory,
        };
    }

    // ---- /proc readers (Linux only; gracefully null on other OS) ----

    private static async _readProcStatus(): Promise<Record<string, number> | null> {
        try {
            const txt = await fs.readFile(`/proc/${process.pid}/status`, "utf-8");
            const keys = ["VmPeak", "VmSize", "VmHWM", "VmRSS", "VmData", "VmStk", "VmExe", "VmSwap", "Threads"];
            const result: Record<string, number> = {};
            for (const line of txt.split("\n")) {
                for (const k of keys) {
                    if (line.startsWith(k + ":")) {
                        const m = line.match(new RegExp(`${k}:\\s+(\\d+)`));
                        if (m) {
                            const v = parseInt(m[1], 10);
                            // VmXxx values are in kB; Threads is a raw count.
                            result[k] = k === "Threads" ? v : v * 1024;
                        }
                    }
                }
            }
            return result;
        } catch { return null; }
    }

    private static async _readProcIo(): Promise<Record<string, number> | null> {
        try {
            const txt = await fs.readFile(`/proc/${process.pid}/io`, "utf-8");
            const result: Record<string, number> = {};
            for (const line of txt.split("\n")) {
                const m = line.match(/^(\w+):\s+(\d+)$/);
                if (m) result[m[1]] = parseInt(m[2], 10);
            }
            return result;
        } catch { return null; }
    }

    private static async _readProcLimits(): Promise<Record<string, { soft: string; hard: string; unit: string }> | null> {
        try {
            const txt = await fs.readFile(`/proc/${process.pid}/limits`, "utf-8");
            const result: Record<string, { soft: string; hard: string; unit: string }> = {};
            const lines = txt.split("\n").slice(1);
            for (const line of lines) {
                // Trailing-3-columns regex: name has 2+ spaces before values
                const m = line.match(/^(.+?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s*$/);
                if (m) result[m[1].trim()] = { soft: m[2], hard: m[3], unit: m[4] };
            }
            return result;
        } catch { return null; }
    }

    private static async _countFds(): Promise<number | null> {
        try {
            const entries = await fs.readdir(`/proc/${process.pid}/fd`);
            return entries.length;
        } catch { return null; }
    }

    // Socket breakdown WITHOUT ss/sudo/shell: resolve this process's socket inodes from
    // /proc/<pid>/fd symlinks, then look those inodes up in the kernel's /proc/net/tcp{,6}
    // tables to get TCP state + remote address. Returns null off Linux (files absent).
    private static async _readSocketBreakdown(): Promise<{
        total: number;
        byState: Record<string, number>;
        topRemotes: Array<{ host: string; established: number }>;
    } | null> {
        try {
            // 1. Collect our socket inodes. fd symlinks look like "socket:[12345]"; dup'd fds share
            //    an inode, so a Set counts sockets (not fds).
            const fdDir = `/proc/${process.pid}/fd`;
            const fds = await fs.readdir(fdDir);
            const inodes = new Set<string>();
            await Promise.all(fds.map(async (fd) => {
                try {
                    const link = await fs.readlink(`${fdDir}/${fd}`);
                    const m = link.match(/^socket:\[(\d+)\]$/);
                    if (m) inodes.add(m[1]);
                } catch { /* fd vanished between readdir and readlink — ignore */ }
            }));
            if (inodes.size === 0) return { total: 0, byState: {}, topRemotes: [] };

            // 2. Scan the kernel TCP tables; keep only rows whose inode is ours.
            const byState: Record<string, number> = {};
            const remoteEstab: Record<string, number> = {};
            let total = 0;
            for (const [file, isV6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
                let txt: string;
                try { txt = await fs.readFile(file, "utf-8"); } catch { continue; }
                for (const line of txt.split("\n").slice(1)) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 10) continue;
                    const inode = parts[9];
                    if (!inodes.has(inode)) continue;
                    total++;
                    const state = this._tcpState(parts[3]);
                    byState[state] = (byState[state] ?? 0) + 1;
                    if (state === "ESTABLISHED") {
                        const host = this._parseHexAddr((parts[2] ?? "").split(":")[0], isV6);
                        remoteEstab[host] = (remoteEstab[host] ?? 0) + 1;
                    }
                }
            }
            const topRemotes = Object.entries(remoteEstab)
                .map(([host, established]) => ({ host, established }))
                .sort((a, b) => b.established - a.established)
                .slice(0, 10);
            return { total, byState, topRemotes };
        } catch { return null; }
    }

    private static _tcpState(hex: string): string {
        switch ((hex || "").toUpperCase()) {
            case "01": return "ESTABLISHED";
            case "02": return "SYN_SENT";
            case "03": return "SYN_RECV";
            case "04": return "FIN_WAIT1";
            case "05": return "FIN_WAIT2";
            case "06": return "TIME_WAIT";
            case "07": return "CLOSE";
            case "08": return "CLOSE_WAIT";
            case "09": return "LAST_ACK";
            case "0A": return "LISTEN";
            case "0B": return "CLOSING";
            case "0C": return "NEW_SYN_RECV";
            default:   return "UNKNOWN(" + hex + ")";
        }
    }

    // /proc/net addresses are hex with little-endian byte order. IPv4 = 8 chars; IPv6 = 32 chars
    // stored as 4 little-endian 32-bit words. Best-effort formatting — good enough to group by host.
    private static _parseHexAddr(hex: string, isV6: boolean): string {
        try {
            if (!isV6) {
                if (hex.length !== 8) return hex;
                return [
                    parseInt(hex.slice(6, 8), 16),
                    parseInt(hex.slice(4, 6), 16),
                    parseInt(hex.slice(2, 4), 16),
                    parseInt(hex.slice(0, 2), 16),
                ].join(".");
            }
            if (hex.length !== 32) return hex;
            const bytes: number[] = [];
            for (let w = 0; w < 4; w++) {
                const word = hex.slice(w * 8, w * 8 + 8);
                for (let b = 3; b >= 0; b--) bytes.push(parseInt(word.slice(b * 2, b * 2 + 2), 16));
            }
            const hextets: string[] = [];
            for (let i = 0; i < 16; i += 2) hextets.push((((bytes[i] << 8) | bytes[i + 1]) >>> 0).toString(16));
            return hextets.join(":");
        } catch { return hex; }
    }

    private static _parseLimitValue(v: string): number | null {
        if (v === "unlimited") return -1;
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : null;
    }

    private static _toMsFinite(ns: number): number {
        return Number.isFinite(ns) ? Math.round((ns / 1e6) * 100) / 100 : 0;
    }

    private static _safePercentileMs(h: ELDHistogram, p: number): number {
        try { return this._toMsFinite(h.percentile(p)); } catch { return 0; }
    }

    private static _safeCount(fn: () => number | undefined): number {
        try { return fn() ?? 0; } catch { return 0; }
    }
}

// Eager-init at module load — background samplers are cheap and worth the head-start.
ProcessMonitor.init();
