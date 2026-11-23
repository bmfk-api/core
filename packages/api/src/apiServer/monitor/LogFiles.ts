// Tail of on-disk logs for the monitor: this process's pm2 stdout/stderr files ("pm2 logs") and,
// optionally, nginx access/error logs.
//
// Safety rules:
//   - The client picks a SOURCE ID, never a path. Paths come from pm2's env or from server-side
//     options, so this can't be turned into an arbitrary-file-read endpoint.
//   - Only a bounded tail window is read (never the whole file — access logs can be gigabytes).
//   - Every line is sanitized: query-string secrets (access logs carry ?token=…), then
//     LogService.sanitize (PAN with Luhn, JWT, Bearer, JSON credential/CHD fields).
//   - `filter` is applied AFTER masking, so it can't be used to probe for secret values.

import fs from "fs/promises";
import { constants as FS } from "fs";
import { LogService } from "../LogService";

export const LOG_SOURCES = ["process-out", "process-err", "nginx-access", "nginx-error"] as const;
export type TLogSourceId = typeof LOG_SOURCES[number];

export interface ILogFilesOptions {
    processOut?: string;   // default: pm2's pm_out_log_path (auto when running under pm2)
    processErr?: string;   // default: pm2's pm_err_log_path
    nginxAccess?: string;  // e.g. /var/log/nginx/gateway.access.log — prefer a per-project file
    nginxError?: string;   // e.g. /var/log/nginx/gateway.error.log
}

export interface ILogTailRequest {
    lines?: number;   // how many trailing lines to return (1..2000, default 200)
    since?: number;   // byte cursor from a previous call → only lines appended after it
    filter?: string;  // case-insensitive substring, matched against the masked line
}

export interface ILogTailResult {
    source: TLogSourceId;
    path: string;
    size: number;       // current file size in bytes
    cursor: number;     // pass back as `since` to get only new lines next time
    rotated: boolean;   // `since` was beyond EOF → file was rotated/truncated, returned a fresh tail
    truncated: boolean; // more than the read window was appended since `since`; older part skipped
    lines: string[];
}

const LABELS: Record<TLogSourceId, string> = {
    "process-out": "Process stdout (pm2 out log)",
    "process-err": "Process stderr (pm2 error log)",
    "nginx-access": "nginx access log",
    "nginx-error": "nginx error log",
};

const MAX_WINDOW = 512 * 1024;   // bytes read per call at most
const MAX_LINE = 4000;           // chars per returned line
const MAX_LINES = 2000;

function resolvePaths(opts?: ILogFilesOptions): Record<TLogSourceId, string | null> {
    const usable = (p?: string | null) => (p && p !== "/dev/null" ? p : null);  // pm2 --no-*-log → /dev/null
    return {
        "process-out": usable(opts?.processOut) ?? usable(process.env.pm_out_log_path),
        "process-err": usable(opts?.processErr) ?? usable(process.env.pm_err_log_path),
        "nginx-access": usable(opts?.nginxAccess),
        "nginx-error": usable(opts?.nginxError),
    };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function cleanLine(raw: string): string {
    // sanitize() covers PAN/JWT/Bearer/JSON credentials AND ?token=… query secrets.
    const line = LogService.sanitize(raw.replace(/\r$/, "").replace(ANSI, ""));
    return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + `…(${line.length} chars)` : line;
}

/** What the monitor can show: every known source, whether it's configured and readable. */
export async function listLogSources(opts?: ILogFilesOptions) {
    const paths = resolvePaths(opts);
    return Promise.all(LOG_SOURCES.map(async id => {
        const path = paths[id];
        const base = { id, label: LABELS[id], path, configured: !!path, exists: false, readable: false,
                       size: null as number | null, modifiedAt: null as number | null, reason: null as string | null };
        if (!path) return { ...base, reason: id.startsWith("process") ? "not running under pm2 and no path configured" : "path not configured (options.logFiles)" };
        try {
            const st = await fs.stat(path);
            base.exists = true; base.size = st.size; base.modifiedAt = st.mtimeMs;
            await fs.access(path, FS.R_OK);
            base.readable = true;
        } catch (e: any) {
            base.reason = e?.code === "ENOENT" ? "file not found"
                        : e?.code === "EACCES" ? "permission denied for the node process user"
                        : String(e?.message ?? e);
        }
        return base;
    }));
}

/** Tail a source: last N lines, or (with `since`) only what was appended since the last call. */
export async function tailLog(id: TLogSourceId, opts: ILogFilesOptions | undefined, req: ILogTailRequest = {}): Promise<ILogTailResult> {
    const path = resolvePaths(opts)[id];
    if (!path) throw new Error(`log source "${id}" is not configured`);

    const wantLines = Math.min(MAX_LINES, Math.max(1, Math.floor(req.lines ?? 200)));
    const fh = await fs.open(path, "r");
    try {
        const { size } = await fh.stat();
        const since = typeof req.since === "number" && Number.isFinite(req.since) ? Math.floor(req.since) : undefined;

        // A valid cursor always sits right after a newline, so reading from it starts on a line
        // boundary. Anything else (fresh tail, window cut) starts mid-line → drop the first fragment.
        let start: number;
        let rotated = false, truncated = false, onBoundary = false;
        if (since !== undefined && since >= 0 && since <= size) {
            start = since; onBoundary = true;
            if (size - start > MAX_WINDOW) { start = size - MAX_WINDOW; truncated = true; onBoundary = false; }
        } else {
            rotated = since !== undefined && since > size;
            start = Math.max(0, size - MAX_WINDOW);
            onBoundary = start === 0;
        }

        const buf = Buffer.alloc(size - start);
        if (buf.length > 0) await fh.read(buf, 0, buf.length, start);

        // Work in BYTES for the cursor (UTF-8), decode only the complete-line span.
        const lastNl = buf.lastIndexOf(0x0a);
        const firstNl = buf.indexOf(0x0a);
        let begin = onBoundary ? 0 : (firstNl >= 0 ? firstNl + 1 : buf.length);
        const end = lastNl >= 0 ? lastNl + 1 : 0;   // hold back a trailing partial line for next time
        if (begin > end) begin = end;

        const text = buf.subarray(begin, end).toString("utf-8");
        let lines = text.length ? text.split("\n") : [];
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        lines = lines.map(cleanLine);

        const filter = typeof req.filter === "string" ? req.filter.trim().toLowerCase() : "";
        if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter));
        if (lines.length > wantLines) lines = lines.slice(-wantLines);

        return { source: id, path, size, cursor: start + end, rotated, truncated, lines };
    } finally {
        await fh.close();
    }
}
