// Collects system-level info via shell commands + os module.
// Linux-first; on other platforms most probes return null/installed:false gracefully.
// Every shell call is wrapped in safeExec with a strict timeout and never receives user input,
// so the surface is limited to the hardcoded command set below.

import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";

const execP = promisify(exec);

type ExecResult = { ok: boolean; stdout: string; stderr: string; code: number };

async function safeExec(cmd: string, timeoutMs = 3000): Promise<ExecResult> {
    try {
        const { stdout, stderr } = await execP(cmd, {
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            shell: "/bin/sh",
        });
        return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
    } catch (e: any) {
        return {
            ok: false,
            stdout: e?.stdout != null ? String(e.stdout) : "",
            stderr: e?.stderr != null ? String(e.stderr) : String(e?.message ?? e),
            code: typeof e?.code === "number" ? e.code : -1,
        };
    }
}

async function commandExists(cmd: string): Promise<boolean> {
    const r = await safeExec(`command -v ${cmd}`, 1000);
    return r.ok && r.stdout.trim().length > 0;
}

// ---- CPU ----

function cpuStatic() {
    const cpus = os.cpus();
    const models: Record<string, number> = {};
    for (const c of cpus) models[c.model] = (models[c.model] ?? 0) + 1;
    return {
        count: cpus.length,
        models,
        loadAvg: os.loadavg(),         // [1m, 5m, 15m]
        platform: process.platform,
        arch: process.arch,
        uptimeSec: os.uptime(),
    };
}

async function cpuUsage(sampleMs = 200) {
    if (process.platform !== "linux") return null;

    const read = async () => {
        try {
            const txt = await fs.readFile("/proc/stat", "utf-8");
            const line = txt.split("\n", 1)[0];
            const parts = line.split(/\s+/).slice(1).map(s => parseInt(s, 10) || 0);
            return {
                user: parts[0] ?? 0,
                nice: parts[1] ?? 0,
                system: parts[2] ?? 0,
                idle: parts[3] ?? 0,
                iowait: parts[4] ?? 0,
                irq: parts[5] ?? 0,
                softirq: parts[6] ?? 0,
                steal: parts[7] ?? 0,
            };
        } catch {
            return null;
        }
    };

    const a = await read();
    if (!a) return null;
    await new Promise(r => setTimeout(r, sampleMs));
    const b = await read();
    if (!b) return null;

    const sum = (x: typeof a) =>
        x.user + x.nice + x.system + x.idle + x.iowait + x.irq + x.softirq + x.steal;
    const total = sum(b) - sum(a);
    if (total <= 0) return null;

    const pct = (delta: number) => Math.round((delta / total) * 1000) / 10;
    return {
        userPct: pct(b.user + b.nice - a.user - a.nice),
        systemPct: pct(b.system - a.system),
        idlePct: pct(b.idle - a.idle),
        iowaitPct: pct(b.iowait - a.iowait),
    };
}

// ---- Memory ----

function memory() {
    const total = os.totalmem();
    const free = os.freemem();
    return {
        total,
        free,
        used: total - free,
        usedPct: Math.round(((total - free) / total) * 1000) / 10,
    };
}

// ---- Disk ----

async function disk() {
    const r = await safeExec("df -kP");
    if (!r.ok) return null;

    const lines = r.stdout.split("\n").slice(1).filter(l => l.trim().length > 0);
    return lines
        .map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6) return null;
            const sizeKB = parseInt(parts[1], 10) || 0;
            const usedKB = parseInt(parts[2], 10) || 0;
            const availKB = parseInt(parts[3], 10) || 0;
            return {
                filesystem: parts[0],
                size: sizeKB * 1024,
                used: usedKB * 1024,
                available: availKB * 1024,
                usePct: parts[4],
                mount: parts.slice(5).join(" "),
            };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null)
        .filter(d => !/^(tmpfs|devtmpfs|squashfs|overlay|udev|none|run)/.test(d.filesystem));
}

// ---- HTTP connections (nginx-default ports 80/443) ----

async function httpConnections(ports = [80, 443]) {
    const portList = ports.join("|");

    const ssCmd = `ss -tnH 2>/dev/null | awk '$1=="ESTAB" && $4 ~ /:(${portList})$/ {print $4, $5}'`;
    let r = await safeExec(ssCmd);
    if (!r.ok || r.stdout.trim().length === 0) {
        const nsCmd = `netstat -tn 2>/dev/null | awk '$6=="ESTABLISHED" && $4 ~ /:(${portList})$/ {print $4, $5}'`;
        r = await safeExec(nsCmd);
        if (!r.ok) return null;
    }

    const lines = r.stdout.split("\n").filter(l => l.trim().length > 0);

    const byRemote: Record<string, number> = {};
    for (const line of lines) {
        const parts = line.split(/\s+/);
        const remote = parts[1] ?? "";
        const ipMatch = remote.match(/^\[?([^\]]+)\]?:\d+$/);
        const ip = ipMatch ? ipMatch[1] : remote;
        byRemote[ip] = (byRemote[ip] ?? 0) + 1;
    }

    const topRemote = Object.entries(byRemote)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([ip, count]) => ({ ip, count }));

    return { ports, total: lines.length, topRemote };
}

// ---- Nginx ----

async function nginx() {
    const installed = await commandExists("nginx");
    if (!installed) return { installed: false };

    const [version, status, listening, workers] = await Promise.all([
        safeExec("nginx -v 2>&1", 1000),
        safeExec("systemctl is-active nginx 2>/dev/null", 1000),
        safeExec("ss -tlnH 2>/dev/null | awk '{print $4}'", 1000),
        safeExec("pgrep -c nginx 2>/dev/null", 1000),
    ]);

    return {
        installed: true,
        version: (version.stdout || version.stderr).trim(),
        status: status.stdout.trim() || "unknown",
        listening: listening.stdout.split("\n").filter(l => l.trim().length > 0),
        workerCount: parseInt(workers.stdout.trim(), 10) || 0,
    };
}

// ---- PM2 ----

async function pm2() {
    const installed = await commandExists("pm2");
    if (!installed) return { installed: false };

    const r = await safeExec("pm2 jlist 2>/dev/null", 3000);
    if (!r.ok) return { installed: true, error: r.stderr.slice(0, 500) };

    // pm2 sometimes prefixes the JSON with warnings/log lines — extract the array slice.
    const text = r.stdout;
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) return { installed: true, error: "no JSON in pm2 jlist output" };

    try {
        const arr = JSON.parse(text.slice(start, end + 1));
        const processes = arr.map((p: any) => ({
            name: p.name,
            pid: p.pid,
            pm_id: p.pm_id,
            status: p.pm2_env?.status,
            uptime: p.pm2_env?.pm_uptime,
            restarts: p.pm2_env?.restart_time,
            cpu: p.monit?.cpu,
            memory: p.monit?.memory,
            exec_mode: p.pm2_env?.exec_mode,
            instances: p.pm2_env?.instances,
            node_version: p.pm2_env?.node_version,
        }));
        return { installed: true, processes };
    } catch {
        return { installed: true, error: "Failed to parse pm2 jlist output" };
    }
}

// ---- Public aggregator ----

export async function collectSystemInfo() {
    const [cpuUsageData, diskData, connectionsData, nginxData, pm2Data] = await Promise.all([
        cpuUsage().catch(() => null),
        disk().catch(() => null),
        httpConnections().catch(() => null),
        nginx().catch(() => ({ installed: false, error: "probe failed" })),
        pm2().catch(() => ({ installed: false, error: "probe failed" })),
    ]);

    return {
        cpu: { ...cpuStatic(), usage: cpuUsageData },
        memory: memory(),
        disk: diskData,
        connections: connectionsData,
        nginx: nginxData,
        pm2: pm2Data,
    };
}
