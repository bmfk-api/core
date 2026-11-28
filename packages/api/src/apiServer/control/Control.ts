// The control channel between the deployer (and `bmfk ps`) and the apps it runs.
//
// Each deployed app listens on a unix socket in its own data folder:
//
//   <data root>/<project>/control[-<slot>].sock      (mode 0600: only the same user can connect)
//
// The deployer chooses the path and hands it to the app in BMFK_CONTROL_SOCKET when it starts it
// (systemd unit or pm2); an app started any other way has no socket. No network port is opened.
//
// Protocol: one JSON object per line. Request {v:1, id, op, args?} → response {v:1, id, ok:true, data}
// or {v:1, id, ok:false, error}. The operations are a fixed list (CONTROL_OPS); there is no generic
// "run this" — anything new is a new, reviewed operation.

import net from "net";
import path from "path";
import { AppData } from "../helper/AppDataPath";

export const CONTROL_PROTOCOL = 1;
export const CONTROL_SOCKET_ENV = "BMFK_CONTROL_SOCKET";
// sun_path is 104 bytes on macOS and 108 on Linux, with the terminating zero.
export const MAX_SOCKET_PATH = 100;
// Lines longer than this are refused, both ways.
export const MAX_LINE = 256 * 1024;

export const CONTROL_OPS = ["ping", "metrics", "ready", "refresh-live", "loglevel"] as const;
export type ControlOp = typeof CONTROL_OPS[number];

export const LOG_LEVEL_NAMES = ["all", "api", "info", "db", "warn", "error", "crit"] as const;

export interface IControlPing {
    pid: number; project: string; slot: "blue" | "green" | null; version: string; node: string;
    uptimeSec: number; live: boolean | null; logLevel: string;
}

export interface IControlMetrics {
    // Over the last 60 seconds (or since start, if shorter).
    requestsPerMin: number;
    errorsPerMin: number;          // answers with a 5xx status
    inFlight: number;              // requests being handled now
    connections: number | null;    // open HTTP connections
    // Event loop over the last ~10 s window.
    loopDelayP99Ms: number | null;
    loopDelayMeanMs: number | null;
    loopUtilizationPct: number | null;
    heapUsed: number; heapLimit: number; rss: number;
}

export interface IControlReady { ready: boolean; checks: { name: string; ok: boolean; detail?: string; ms: number }[] }

// The socket of a project (or a blue-green slot), or null when the path would be too long.
export function controlSocketPath(project: string, slot: "blue" | "green" | null): string | null {
    const p = path.join(AppData.projectDir(project), `control${slot ? "-" + slot : ""}.sock`);
    return Buffer.byteLength(p) <= MAX_SOCKET_PATH ? p : null;
}

// Splits a stream into lines; refuses (calls onTooLong) a line over MAX_LINE.
export function lineReader(onLine: (line: string) => void, onTooLong: () => void): (chunk: Buffer | string) => void {
    let buf = "";
    return (chunk) => {
        buf += chunk.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) onLine(line);
        }
        if (buf.length > MAX_LINE) { buf = ""; onTooLong(); }
    };
}

export class ControlError extends Error {
    constructor(message: string, readonly code: "unreachable" | "timeout" | "refused" | "protocol") { super(message); }
}

let nextId = 1;

/**
 * One request to an app's control socket. Rejects with ControlError: "unreachable" (no socket,
 * nobody listening — an app without the channel, or stopped), "timeout", "refused" (the app said
 * no: ok:false) or "protocol".
 */
export function controlCall<T = unknown>(socket: string, op: ControlOp, args?: Record<string, unknown>, timeoutMs = 2000): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        let done = false;
        const conn = net.createConnection(socket);
        const finish = (err: ControlError | null, data?: T) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            conn.destroy();
            err ? reject(err) : resolve(data as T);
        };
        const timer = setTimeout(() => finish(new ControlError(`${op}: no answer in ${timeoutMs} ms`, "timeout")), timeoutMs);
        conn.on("error", (e: any) => finish(new ControlError(`${op}: ${e?.code === "ENOENT" || e?.code === "ECONNREFUSED" ? "the app has no control socket open" : e?.message ?? e}`, "unreachable")));
        conn.on("close", () => finish(new ControlError(`${op}: the app closed the connection`, "protocol")));
        conn.on("data", lineReader((line) => {
            let msg: any;
            try { msg = JSON.parse(line); } catch { return finish(new ControlError(`${op}: not JSON`, "protocol")); }
            if (msg?.id !== id) return;
            if (msg.ok === true) finish(null, msg.data as T);
            else finish(new ControlError(`${op}: ${String(msg?.error ?? "refused")}`, "refused"));
        }, () => finish(new ControlError(`${op}: answer too long`, "protocol"))));
        conn.on("connect", () => conn.write(JSON.stringify({ v: CONTROL_PROTOCOL, id, op, ...(args ? { args } : {}) }) + "\n"));
    });
}
