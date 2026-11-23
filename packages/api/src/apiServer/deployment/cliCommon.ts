// Shared bits for the deployer CLI commands (backups, restore).

import crypto from "crypto";
import { ErrorUtils } from "../structures/DefaultErrors";
import { IDeployerConfig } from "./resolveConfig";
import { InterceptorSignedAuth } from "../interceptors/InterceptorSignedAuth";

/** pckg/<endpoint> derived from the deploy config's host (…/pckg/add → …/pckg/<endpoint>). */
export function deployerUrl(opt: IDeployerConfig, endpoint: string): string {
    if (/\/add\/?$/.test(opt.host)) return opt.host.replace(/\/add\/?$/, "/" + endpoint);
    if (opt.switch_host && /\/switch\/?$/.test(opt.switch_host))
        return opt.switch_host.replace(/\/switch\/?$/, "/" + endpoint);
    throw new Error(`Cannot derive the ${endpoint} URL from host "${opt.host}" — make sure "host" ends with /add.`);
}

export function authHeader(opt: IDeployerConfig): string {
    return "Bearer " + crypto.createHash("sha256").update(opt.username + ":" + opt.password).digest("hex");
}

/**
 * Headers for ONE deployer call. With a privateKey in deploy.json the request is signed
 * (InterceptorSignedAuth): the signature covers this url, these fields and the uploaded files, and
 * is good once — so build headers per request, never reuse them. Without a key: the old Bearer.
 * X-Deployer-Login names the user either way (older servers ignore it).
 */
export function deployerHeaders(opt: IDeployerConfig, url: string, data: unknown, files?: Record<string, string>): Record<string, string> {
    const authorization = opt.privateKey
        ? InterceptorSignedAuth.sign({ privateKey: opt.privateKey, kid: String(opt.username), method: "POST", url, data, files })
        : authHeader(opt);
    return { authorization, "x-deployer-login": String(opt.username) };
}

/** Human-readable reason a deployer call failed, or null when it succeeded. */
export function responseError(r: any): string | null {
    const body = r?.ok ? r?.data : r?.error;
    const e = (body && typeof body === "object")
        ? (body.error ?? (ErrorUtils.isError(body.data) ? body.data : null) ?? (ErrorUtils.isError(body) ? body : null))
        : null;
    if (e && (e.message || e.details)) {
        const text = [e.message, e.details].filter(Boolean).join(" — ");
        return e.code !== undefined ? `${text} (code ${e.code})` : text;
    }
    if (!r?.ok) {
        if (r?.status !== undefined) return `HTTP ${r.status}`;
        const raw = typeof r?.error === "string" ? r.error : JSON.stringify(r?.error);
        return "network error: " + raw;
    }
    return null;
}

export function palette() {
    const on = !!process.stdout.isTTY && !process.env.NO_COLOR;
    const c = (code: string) => (t: string) => on ? `\x1b[${code}m${t}\x1b[0m` : t;
    return { red: c("31"), green: c("32"), yellow: c("33"), blue: c("34"), dim: c("2"), bold: c("1") };
}

export function fmtDate(ms: number): string {
    const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtSize(kb: number | null | undefined): string {
    if (kb === null || kb === undefined) return "—";
    if (kb < 1024) return `${kb} KB`;
    if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
    return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtMs(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * One line per step of a long command: "  ✓ build    npm run build  4.2s". start() shows a spinner
 * with the running time until the step is closed — in a TTY only; piped output (CI logs) gets just
 * the final line of each step, no cursor tricks.
 */
export function stepLog() {
    const p = palette();
    const tty = !!process.stdout.isTTY;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const row = (mark: string, name: string, text: string, ms?: number) =>
        `  ${mark} ${name.padEnd(8)} ${text}` + (ms !== undefined ? "  " + p.dim(fmtMs(ms)) : "");

    const log = {
        ok:   (name: string, text: string, ms?: number) => console.log(row(p.green("✓"), name, text, ms)),
        skip: (name: string, text: string) => console.log(row(p.dim("–"), name, p.dim(text))),
        warn: (name: string, text: string) => console.log(row(p.yellow("⚠"), name, p.yellow(text))),
        fail: (name: string, text: string, ms?: number) => console.log(row(p.red("✗"), name, p.red(text), ms)),
        /** A detail line under the last step, aligned with its text. */
        note: (text: string) => console.log(" ".repeat(13) + p.dim(text)),
        start(name: string, text: string) {
            const startedAt = Date.now();
            let frame = 0;
            const draw = () => {
                const plain = `  ${frames[frame++ % frames.length]} ${name.padEnd(8)} ${text}  ${fmtMs(Date.now() - startedAt)}`;
                process.stdout.write("\r\x1b[2K" + plain.slice(0, Math.max(20, (process.stdout.columns || 80) - 1)));
            };
            const timer = tty ? setInterval(draw, 80) : null;
            if (tty) draw();
            const stop = () => {
                if (!timer) return;
                clearInterval(timer);
                process.stdout.write("\r\x1b[2K");
            };
            return {
                ok:   (done?: string) => { stop(); log.ok(name, done ?? text, Date.now() - startedAt); },
                fail: (done?: string) => { stop(); log.fail(name, done ?? text, Date.now() - startedAt); },
            };
        },
    };
    return log;
}
