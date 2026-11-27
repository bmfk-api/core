import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { IMonitorUser, IDocumentationUser } from "../APIService";
import { logError, logInfo, logWarn } from "../LogService";
import { IpAllowList } from "../helper/IpAllowList";

export interface IAccess {
    monitor?: IMonitorUser[],
    documentation?: IDocumentationUser[],
    // Addresses the monitor (every sm/* request, sign-in included) answers to: IPs and CIDR
    // subnets. Absent or empty → any address.
    monitorAllowedIps?: string[]
}

const ROLES = ["admin", "it", "analytic"];

// Holds options.access. Given an object it is static, as before. Given a path to a JSON file
// ({ monitor:[…], documentation:[…] }) the file is watched and re-read on change, so access can
// be granted or revoked without a restart or a redeploy.
//
// A file that is missing, unreadable or invalid never replaces a good copy: the previous access
// stays in force and the reason is logged. At startup there is no previous copy — then nobody
// gets in until the file is fixed (the watcher picks the fix up), instead of the app crashing.
export class AccessStore {
    private current: IAccess = {};
    private hash = "";
    private refusedHash = "";   // last refused content — reported once, not on every poll
    private file: string | null = null;
    private debounce: NodeJS.Timeout | null = null;

    // onChange(previous, next) runs after every successful load, the first one included.
    // `optional`: the default file, which a project may never create — its absence is not an error.
    constructor(source: IAccess | string | undefined | null, private onChange?: (prev: IAccess, next: IAccess) => void, private optional = false) {
        if (typeof source !== "string") {
            this.apply(source ?? {});
            return;
        }
        this.file = path.resolve(source);
        this.loadSync();
        this.watch();
    }

    get monitor(): IMonitorUser[] { return this.current.monitor ?? []; }
    get documentation(): IDocumentationUser[] { return this.current.documentation ?? []; }
    get monitorAllowedIps(): string[] { return this.current.monitorAllowedIps ?? []; }

    // null when the content is usable, otherwise why not. The whole file is refused on any
    // error: half-applying an access list is worse than keeping the previous one.
    static validate(value: any): string | null {
        if (!value || typeof value !== "object" || Array.isArray(value)) return "root must be an object";
        if (value.monitorAllowedIps !== undefined) {
            if (!Array.isArray(value.monitorAllowedIps) || value.monitorAllowedIps.some((e: any) => typeof e !== "string"))
                return "monitorAllowedIps must be an array of strings";
            const ips = IpAllowList.build(value.monitorAllowedIps);
            if (ips.error) return "monitorAllowedIps: " + ips.error;
        }
        for (const list of ["monitor", "documentation"] as const) {
            const users = value[list];
            if (users === undefined) continue;
            if (!Array.isArray(users)) return `"${list}" must be an array`;
            const seen = new Set<string>();
            for (const [i, u] of users.entries()) {
                const at = `${list}[${i}]`;
                if (!u || typeof u !== "object") return `${at} must be an object`;
                if (typeof u.login !== "string" || !u.login.trim()) return `${at}.login must be a non-empty string`;
                // ":" separates the realm in sessions and 2FA records ("doc:<login>"); a login can't forge one.
                if (u.login.includes(":")) return `${at}.login must not contain ":"`;
                if (typeof u.password !== "string") return `${at}.password must be a string`;
                if (seen.has(u.login)) return `${at}: duplicate login "${u.login}"`;
                seen.add(u.login);
                if (u.role !== undefined && !ROLES.includes(u.role)) return `${at}.role must be one of ${ROLES.join(", ")}`;
                if (u.totpSecret !== undefined && typeof u.totpSecret !== "string") return `${at}.totpSecret must be a string`;
                if (u.endpoints !== undefined && (!Array.isArray(u.endpoints) || u.endpoints.some((e: any) => typeof e !== "string")))
                    return `${at}.endpoints must be an array of strings`;
            }
        }
        return null;
    }

    private loadSync() {
        try {
            this.accept(fs.readFileSync(this.file!, "utf-8"), true);
        } catch (e: any) {
            if (e.code === "ENOENT" && this.optional)
                logInfo(`Access: no ${this.file} — the monitor and the documentation are closed. Create it with: npx bmfk access-config ${this.file}`);
            else
                logError(`Access file ${this.file}: ${e.code === "ENOENT" ? "not found" : e.message} — no one can access the monitor and documentation until it is fixed`);
        }
    }

    private async reload() {
        let raw: string;
        try {
            raw = await fs.promises.readFile(this.file!, "utf-8");
        } catch (e: any) {
            // Editors replace files via tmp+rename: a read can land in the gap. The previous copy
            // stays; the next event or the poll retries.
            if (e.code !== "ENOENT") logWarn(`Access file ${this.file}: ${e.message} — keeping the previous access`);
            return;
        }
        this.accept(raw, false);
    }

    private accept(raw: string, initial: boolean) {
        const hash = crypto.createHash("sha256").update(raw).digest("hex");
        if (hash === this.hash || hash === this.refusedHash) return;   // unchanged (the poll hits this every minute)

        let parsed: any;
        try { parsed = JSON.parse(raw); }
        catch (e: any) { this.refusedHash = hash; return this.refuse(`invalid JSON (${e.message})`, initial); }
        const problem = AccessStore.validate(parsed);
        if (problem) this.refusedHash = hash;
        if (problem) return this.refuse(problem, initial);

        this.hash = hash;
        this.refusedHash = "";
        this.warnPermissions();
        this.apply({ monitor: parsed.monitor, documentation: parsed.documentation, monitorAllowedIps: parsed.monitorAllowedIps });
        logInfo(`Access ${initial ? "loaded" : "reloaded"} from ${this.file}: ${this.monitor.length} monitor, ${this.documentation.length} documentation user(s)`
            + (this.monitorAllowedIps.length ? `, monitor limited to ${this.monitorAllowedIps.join(", ")}` : ""));
        const noRole = this.monitor.filter(u => !u.role).map(u => u.login);
        if (noRole.length)
            logWarn(`Access: monitor user(s) without a role get no access: ${noRole.join(", ")} — set admin, it or analytic (npx bmfk access-config ${this.file})`);
    }

    private refuse(reason: string, initial: boolean) {
        if (initial) logError(`Access file ${this.file}: ${reason} — no one can access the monitor and documentation until it is fixed`);
        else logError(`Access file ${this.file}: ${reason} — change ignored, keeping the previous access`);
    }

    private apply(next: IAccess) {
        const prev = this.current;
        this.current = next;
        try { this.onChange?.(prev, next); }
        catch (e) { logError(`Access change handler threw: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // The file holds password hashes (and documentation passwords in plain text).
    private warnPermissions() {
        try {
            const mode = fs.statSync(this.file!).mode;
            if (mode & 0o077)
                logWarn(`Access file ${this.file} is readable by other users (mode ${(mode & 0o777).toString(8)}) — chmod 600 it`);
        } catch { /* the content was just read; a stat failure here is not worth reporting */ }
    }

    // Watches the directory, not the file: editors that save via tmp+rename replace the inode,
    // and a watch on the old one would go silent. The poll covers watch handles that die anyway.
    private watch() {
        const dir = path.dirname(this.file!), name = path.basename(this.file!);
        try {
            fs.watch(dir, (_event, filename) => {
                if (filename && filename !== name) return;
                if (this.debounce) clearTimeout(this.debounce);
                this.debounce = setTimeout(() => { this.debounce = null; this.reload(); }, 200);
            }).unref();
        } catch (e: any) {
            logWarn(`Access file: cannot watch ${dir} (${e.message}) — changes are picked up within a minute`);
        }
        setInterval(() => this.reload(), 60_000).unref();
    }
}
