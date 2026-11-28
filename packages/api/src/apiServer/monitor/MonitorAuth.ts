// Authentication for the monitor console: password policy, TOTP second factor, sessions and
// lockout. Kept in one place so the rules are auditable, and deliberately dependency-free —
// TOTP is RFC 6238, which is just HMAC-SHA1 over a time counter.
//
// Why sessions rather than the request-signing used for payment APIs: the monitor is a browser
// page, and a browser cannot keep a shared HMAC secret — it would sit in the page's JS for anyone
// to read, making the signature no stronger than the password it replaces.

import crypto from "crypto";
import { AppData } from "../helper/AppDataPath";
import fs from "fs";
import path from "path";
import { IMonitorUser } from "../APIService";
import { logWarn, logInfo, logError } from "../LogService";
import { FailureCounter } from "../helper/FailureCounter";
import { PasswordHash } from "../helper/PasswordHash";

export interface IMonitorSession {
    token: string;
    login: string;
    createdAt: number;
    lastSeenAt: number;
}

interface ITotpRecord { secret: string; enrolledAt: number; lastCounter: number; }

export type TMonitorRole = "admin" | "it" | "analytic";
export type TMonitorCapability = "dashboard" | "logs" | "admin";

export class MonitorAuth {

    // What each role may reach. "dashboard" is metrics and process health; "logs" additionally
    // exposes request/application logs — i.e. where cardholder data could surface; "admin" covers
    // actions that change the running service.
    private static readonly ROLE_CAPS: Record<TMonitorRole, TMonitorCapability[]> = {
        admin:    ["dashboard", "logs", "admin"],
        it:       ["dashboard", "logs"],
        analytic: ["dashboard"],
    };

    /** A user without a known role gets nothing: least privilege wants the role spelled out. */
    static roleAllows(role: string | undefined | null, capability: TMonitorCapability): boolean {
        return (MonitorAuth.ROLE_CAPS[role as TMonitorRole] ?? []).includes(capability);
    }

    static describeRole(role: string | undefined | null): { role: string, capabilities: TMonitorCapability[] } {
        const caps = MonitorAuth.ROLE_CAPS[role as TMonitorRole];
        return caps ? { role: role as string, capabilities: caps } : { role: "none", capabilities: [] };
    }

    // ---- persistent 2FA store ----
    // The TOTP secret is shared state: the authenticator app and the server each hold a copy and
    // derive the same code from it. Lose the server copy and every code becomes wrong, so it MUST
    // outlive restarts — and, under blue-green, must live OUTSIDE the slot directory, which each
    // deploy recreates from scratch.
    private static authFile: string | null = null;
    private static projectKey = "default";
    private static enrolled = new Map<string, ITotpRecord>();
    private static storeLoaded = false;

    /** Turn a project name into something safe to put in a filename. */
    private static fileSafe(name: string): string {
        const safe = String(name || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
        return safe.length > 0 ? safe.slice(0, 64) : "default";
    }

    /**
     * Point the store at a location OUTSIDE any deploy slot (blue-green recreates the slot on
     * every deploy and would wipe enrollments).
     *   authFile — exact path, wins when both are given;
     *   authDir  — directory; the file name is derived from the project, so several projects on
     *              one server land in separate files without extra configuration.
     */
    static configure(opts?: { authFile?: string | null, authDir?: string | null, projectName?: string }) {
        const authFile = opts?.authFile;
        const authDir = opts?.authDir;
        const project = opts?.projectName;

        if (authFile && authFile.length > 0)
            MonitorAuth.authFile = authFile;
        else if (authDir && authDir.length > 0)
            MonitorAuth.authFile = path.join(authDir, `monitor-2fa.${MonitorAuth.fileSafe(project ?? "")}.json`);
        else {
            // Default: <data folder>/<project>/monitor-2fa.json (null — memory only — when it can't be created).
            const dir = AppData.dir("");
            MonitorAuth.authFile = dir ? path.join(dir, "monitor-2fa.json") : null;
        }
        // Several projects can live on one server and may even share this file, so every
        // enrollment is namespaced by project — logins from different projects never collide.
        MonitorAuth.projectKey = (project && project.length > 0 ? project : "default");
        MonitorAuth.stopWatchingStore();
        MonitorAuth.enrolled.clear();
        MonitorAuth.storeHash = "";
        MonitorAuth.refusedHash = "";
        MonitorAuth.missingSince = 0;
        MonitorAuth.storeLoaded = false;
        MonitorAuth.loadStore();
        if (!MonitorAuth.authFile)
            logWarn(`Monitor 2FA: no monitorAuthFile / monitorAuthDir and ${AppData.root()} can't be created — enrollments live in memory only and are LOST on restart`);
    }

    // The file is watched like access.json: deleting a user's entry (or the whole file) takes
    // effect within a second — that user's sessions end and the next login enrolls again.
    private static storeHash = "";
    private static refusedHash = "";
    private static storeWatcher: fs.FSWatcher | null = null;
    private static storePoll: NodeJS.Timeout | null = null;
    private static storeDebounce: NodeJS.Timeout | null = null;
    private static missingSince = 0;

    /** This project's enrollments in a store document (the root `users` is the pre-namespacing layout). */
    private static sectionOf(doc: any): Map<string, ITotpRecord> {
        const section = doc?.projects?.[MonitorAuth.projectKey]?.users ?? doc?.users ?? {};
        const out = new Map<string, ITotpRecord>();
        for (const [login, rec] of Object.entries(section ?? {})) {
            const r = rec as any;
            if (r && typeof r.secret === "string" && r.secret.length > 0)
                out.set(login, { secret: r.secret, enrolledAt: Number(r.enrolledAt) || 0, lastCounter: Number(r.lastCounter) || 0 });
        }
        return out;
    }

    private static loadStore() {
        if (MonitorAuth.storeLoaded) return;
        MonitorAuth.storeLoaded = true;
        if (!MonitorAuth.authFile) return;
        MonitorAuth.reloadStore(true);
        MonitorAuth.watchStore();
    }

    // Re-reads the file and applies the difference. Called at startup, on file events and by the
    // poll. A missing file means "no enrollments"; an unreadable one keeps the current state.
    private static reloadStore(initial = false) {
        const file = MonitorAuth.authFile;
        if (!file) return;
        let raw: string | null = null;
        try {
            raw = fs.readFileSync(file, "utf-8");
        } catch (e: any) {
            if (e?.code !== "ENOENT") {
                logWarn(`Monitor 2FA: cannot read ${file} (${e?.message ?? e}) — keeping current enrollments`);
                return;
            }
        }

        let next: Map<string, ITotpRecord>;
        let hash: string;
        if (raw === null) {
            if (!initial && MonitorAuth.storeHash !== "missing") {
                // Editors and tools may delete and recreate the file: act only if it stays gone.
                if (!MonitorAuth.missingSince) {
                    MonitorAuth.missingSince = Date.now();
                    setTimeout(() => MonitorAuth.reloadStore(), 1000).unref();
                    return;
                }
                if (Date.now() - MonitorAuth.missingSince < 900) return;
            }
            next = new Map();
            hash = "missing";
        } else {
            MonitorAuth.missingSince = 0;
            hash = crypto.createHash("sha256").update(raw).digest("hex");
            if (hash === MonitorAuth.storeHash || hash === MonitorAuth.refusedHash) return;
            try {
                next = MonitorAuth.sectionOf(JSON.parse(raw));
            } catch (e: any) {
                MonitorAuth.refusedHash = hash;
                logError(`Monitor 2FA: ${file} is not valid JSON (${e?.message ?? e}) — change ignored, keeping current enrollments`);
                return;
            }
        }
        MonitorAuth.missingSince = 0;
        if (hash === MonitorAuth.storeHash) return;
        MonitorAuth.storeHash = hash;
        MonitorAuth.refusedHash = "";

        // Whoever lost their enrollment (or got a different secret) loses their sessions now.
        for (const [login, rec] of MonitorAuth.enrolled) {
            const now = next.get(login);
            if (now && now.secret === rec.secret) continue;
            MonitorAuth.revokeAllFor(login);
            MonitorAuth.usedTotpCounter.delete(login);
            logWarn(`Monitor 2FA: enrollment of "${login}" ${now ? "changed" : "removed"} — sessions revoked${now ? "" : ", the next login enrolls again"}`, "MonitorAuth");
        }
        MonitorAuth.enrolled = next;

        if (raw !== null) {
            try {
                const mode = fs.statSync(file).mode;
                if (mode & 0o077)
                    logWarn(`Monitor 2FA: ${file} is readable by other users (mode ${(mode & 0o777).toString(8)}) — chmod 600 it`);
            } catch { /* just read it; not worth reporting */ }
        }
        if (initial)
            logInfo(`Monitor 2FA: loaded ${next.size} enrollment(s) for project "${MonitorAuth.projectKey}" from ${file}`, "MonitorAuth");
        else
            logInfo(`Monitor 2FA: reloaded ${file} — ${next.size} enrollment(s)`, "MonitorAuth");
    }

    // Watches the directory: tmp+rename saves replace the inode and a file watch would go silent.
    private static watchStore() {
        const file = MonitorAuth.authFile;
        if (!file) return;
        MonitorAuth.stopWatchingStore();
        const dir = path.dirname(file), name = path.basename(file);
        try {
            fs.mkdirSync(dir, { recursive: true });
            MonitorAuth.storeWatcher = fs.watch(dir, (_event, filename) => {
                if (filename && filename !== name) return;
                if (MonitorAuth.storeDebounce) clearTimeout(MonitorAuth.storeDebounce);
                MonitorAuth.storeDebounce = setTimeout(() => { MonitorAuth.storeDebounce = null; MonitorAuth.reloadStore(); }, 200);
            });
            MonitorAuth.storeWatcher.unref();
        } catch (e: any) {
            logWarn(`Monitor 2FA: cannot watch ${dir} (${e?.message ?? e}) — changes are picked up within a minute`);
        }
        MonitorAuth.storePoll = setInterval(() => MonitorAuth.reloadStore(), 60_000);
        MonitorAuth.storePoll.unref();
    }

    private static stopWatchingStore() {
        MonitorAuth.storeWatcher?.close();
        MonitorAuth.storeWatcher = null;
        if (MonitorAuth.storePoll) clearInterval(MonitorAuth.storePoll);
        MonitorAuth.storePoll = null;
    }

    // Writes ONE enrollment into the file as it is on disk now. Writing the in-memory map back
    // would resurrect entries an operator just deleted (and the poll may not have seen it yet).
    private static saveEnrollment(login: string, rec: ITotpRecord): boolean {
        const file = MonitorAuth.authFile;
        if (!file) return true;
        try {
            // Read-modify-write: other projects may own other sections of this same file.
            let doc: any = { version: 1, projects: {} };
            try {
                const existing = JSON.parse(fs.readFileSync(file, "utf-8"));
                if (existing && typeof existing === "object")
                    doc = { version: 1, projects: existing.projects ?? {} };
                // pre-namespacing layout: keep its entries under this project
                if (existing?.users && !existing.projects?.[MonitorAuth.projectKey])
                    doc.projects[MonitorAuth.projectKey] = { users: existing.users };
            } catch (e: any) {
                if (e?.code !== "ENOENT") {
                    // Unreadable file: overwriting it could erase other projects' enrollments.
                    logError(`Monitor 2FA: cannot update ${file} (${e?.message ?? e}) — enrollment not saved`);
                    return false;
                }
            }
            const section = doc.projects[MonitorAuth.projectKey] ?? { users: {} };
            section.users = { ...(section.users ?? {}), [login]: rec };
            doc.projects[MonitorAuth.projectKey] = section;

            const text = JSON.stringify(doc, null, 2);
            const tmp = file + ".tmp";
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // 0600: this file is as sensitive as a password.
            fs.writeFileSync(tmp, text, { encoding: "utf-8", mode: 0o600 });
            fs.renameSync(tmp, file);

            // Memory mirrors exactly what is on disk now; the watcher event for our own write is a no-op.
            const prev = MonitorAuth.enrolled;
            MonitorAuth.enrolled = MonitorAuth.sectionOf(doc);
            for (const [l, r] of prev)
                if (!MonitorAuth.enrolled.has(l) || MonitorAuth.enrolled.get(l)!.secret !== r.secret) {
                    MonitorAuth.revokeAllFor(l);
                    logWarn(`Monitor 2FA: enrollment of "${l}" was removed on disk — sessions revoked`, "MonitorAuth");
                }
            MonitorAuth.storeHash = crypto.createHash("sha256").update(text).digest("hex");
            MonitorAuth.missingSince = 0;
            return true;
        } catch (e: any) {
            logWarn("Monitor 2FA: cannot persist store: " + (e?.message ?? e));
            return false;
        }
    }

    /** Config-provisioned secret wins; otherwise whatever was enrolled at runtime. */
    static secretFor(user: IMonitorUser): string | null {
        MonitorAuth.loadStore();
        if (user?.totpSecret) return user.totpSecret;
        return MonitorAuth.enrolled.get(user?.login)?.secret ?? null;
    }

    static isEnrolled(user: IMonitorUser): boolean {
        return !!MonitorAuth.secretFor(user);
    }

    // PCI DSS v4.0 (8.3.6) wants 12 characters; 8 is only allowed when a system cannot do more.
    static MIN_PASSWORD_LENGTH = 12;

    static SESSION_IDLE_MS = 15 * 60 * 1000;      // 8.2.8 — re-authenticate after 15 min idle
    static SESSION_MAX_MS = 8 * 60 * 60 * 1000;   // absolute cap regardless of activity
    static MAX_FAILED_ATTEMPTS = 10;              // 8.3.4
    static LOCKOUT_MS = 30 * 60 * 1000;

    private static sessions = new Map<string, IMonitorSession>();
    private static failures = new FailureCounter(MonitorAuth.MAX_FAILED_ATTEMPTS, MonitorAuth.LOCKOUT_MS);
    // Last TOTP counter accepted per login: a 6-digit code stays valid for the whole step, so
    // without this a shoulder-surfed code could simply be replayed.
    private static usedTotpCounter = new Map<string, number>();

    // ---- password policy ----

    /** null when the password is acceptable, otherwise the reason. */
    static passwordPolicyError(password: string | undefined | null): string | null {
        if (typeof password !== "string" || password.length === 0)
            return "password is empty";
        if (password.trim().length === 0)
            return "password is whitespace only";
        if (password.length < MonitorAuth.MIN_PASSWORD_LENGTH)
            return `password must be at least ${MonitorAuth.MIN_PASSWORD_LENGTH} characters`;
        return null;
    }

    /** Users that can log in at all: only a scrypt hash is accepted as a stored password. */
    static compliantUsers(users: IMonitorUser[]): IMonitorUser[] {
        return users.filter(u => u && typeof u.login === "string" && u.login.length > 0
            && PasswordHash.isHash(u.password));
    }

    static policyReportFor(users: IMonitorUser[]): string[] {
        const out: string[] = [];
        for (const u of users || []) {
            // The length policy was enforced when the hash was generated by `bmfk hash-password`.
            const reason = !u?.login ? "login is empty"
                : PasswordHash.isHash(u.password) ? null
                : MonitorAuth.PLAINTEXT_ERROR;
            if (reason) out.push(`${u?.login || "<no login>"}: ${reason}`);
        }
        return out;
    }

    static PLAINTEXT_ERROR = "password is built incorrectly — the config must hold a hash from `npx bmfk hash-password`, not the password itself";

    /** Logins whose password sits in the config as plain text — they cannot log in. */
    static plaintextLogins(users: IMonitorUser[]): string[] {
        return (users || []).filter(u => u?.login && !PasswordHash.isHash(u.password)).map(u => u.login);
    }

    // ---- TOTP (RFC 6238) ----

    private static base32Decode(input: string): Buffer {
        const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let bits = 0, value = 0;
        const out: number[] = [];
        for (const ch of input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase()) {
            const idx = A.indexOf(ch);
            if (idx < 0) throw new Error("invalid base32 in TOTP secret");
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
        }
        return Buffer.from(out);
    }

    private static hotp(secret: Buffer, counter: number): string {
        const buf = Buffer.alloc(8);
        buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
        buf.writeUInt32BE(counter >>> 0, 4);
        const h = crypto.createHmac("sha1", secret).update(buf).digest();
        const off = h[h.length - 1] & 0x0f;
        const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16)
                   | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
        return String(code % 1000000).padStart(6, "0");
    }

    /** Checks a 6-digit code against ±1 time step (clock skew) and refuses a code already used. */
    static verifyTotp(login: string, secretBase32: string, code: string): string | null {
        if (!/^\d{6}$/.test(String(code || "").trim()))
            return "TOTP code must be 6 digits";
        let secret: Buffer;
        try { secret = MonitorAuth.base32Decode(secretBase32); }
        catch { return "TOTP secret is not valid base32"; }

        const counter = Math.floor(Date.now() / 1000 / 30);
        const given = String(code).trim();
        for (const c of [counter, counter - 1, counter + 1]) {
            const expected = MonitorAuth.hotp(secret, c);
            const a = Buffer.from(expected), b = Buffer.from(given);
            if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
                const last = MonitorAuth.usedTotpCounter.get(login);
                if (last !== undefined && c <= last) return "TOTP code already used";
                MonitorAuth.usedTotpCounter.set(login, c);
                return null;
            }
        }
        return "TOTP code is invalid";
    }

    private static base32Encode(buf: Buffer): string {
        const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let bits = 0, value = 0, out = "";
        for (const b of buf) {
            value = (value << 8) | b;
            bits += 8;
            while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
        }
        if (bits > 0) out += A[(value << (5 - bits)) & 31];
        return out;
    }

    /** Enrollment helper: a fresh secret plus the otpauth:// URI to render as a QR code. */
    static generateTotpSecret(login: string, issuer = "Monitor"): { secret: string, uri: string } {
        // 20 random BYTES encoded as base32 — the standard size for HMAC-SHA1 TOTP, and exactly
        // 32 base32 characters, so nothing is lost or padded. Picking N random base32 characters
        // instead would give a bit length that is not a whole number of bytes: the trailing bits
        // get dropped, and an authenticator that rounds differently derives a different key, so
        // every generated code mismatches.
        const secret = MonitorAuth.base32Encode(crypto.randomBytes(20));
        // In otpauth://totp/ISSUER:ACCOUNT the colon IS the separator, so an issuer containing one
        // would make the authenticator parse the label wrong. Strip colons and control characters.
        const safeIssuer = String(issuer || "").replace(/[:\u0000-\u001f]/g, " ").trim() || "Monitor";
        const label = encodeURIComponent(`${safeIssuer}:${login}`);
        const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(safeIssuer)}&algorithm=SHA1&digits=6&period=30`;
        return { secret, uri };
    }

    // ---- lockout ----

    static lockoutRemainingMs(login: string): number {
        return MonitorAuth.failures.lockedFor(login);
    }

    private static registerFailure(login: string) {
        MonitorAuth.failures.fail(login);
    }

    private static clearFailures(login: string) {
        MonitorAuth.failures.clear(login);
    }

    // ---- credentials ----

    private static sameSecret(a: string, b: string): boolean {
        const x = Buffer.from(String(a), "utf-8"), y = Buffer.from(String(b), "utf-8");
        return x.length === y.length && crypto.timingSafeEqual(x, y);
    }

    /**
     * Verifies login + password (+ TOTP when the user has a secret).
     * Returns the user, or a reason string — the caller decides what to reveal.
     */
    static async authenticate(users: IMonitorUser[], login: string, password: string, totp?: string)
        : Promise<{ user?: IMonitorUser, error?: string, enrollmentRequired?: boolean }> {

        const locked = MonitorAuth.lockoutRemainingMs(login);
        if (locked > 0)
            return { error: `account locked, try again in ${Math.ceil(locked / 60000)} min` };

        const all = users || [];
        const candidate = all.find(u => u?.login === login);
        if (!candidate) {
            MonitorAuth.registerFailure(login);
            return { error: "Invalid user" };
        }

        if (!PasswordHash.isHash(candidate.password)) {
            // Plain text in the config is refused outright. The caller gets the same answer as for
            // a wrong password — how the server stores credentials is nobody's business outside;
            // the operator finds the reason in the log.
            const matches = typeof candidate.password === "string" && candidate.password.length > 0
                && MonitorAuth.sameSecret(candidate.password, password || "");
            if (matches)
                logError(`Monitor: "${login}" signed in with the right password, but it is stored in the config as plain text — refused; store a hash: npx bmfk hash-password`);
            MonitorAuth.registerFailure(login);
            return { error: "Invalid user" };
        }
        if (!(await PasswordHash.verify(password || "", candidate.password))) {
            MonitorAuth.registerFailure(login);
            return { error: "Invalid user" };
        }

        const secret = MonitorAuth.secretFor(candidate);
        if (!secret) {
            // Password is correct but there is no second factor yet. The caller must run the
            // enrollment flow; no session is issued, so the console stays unusable until then.
            MonitorAuth.clearFailures(login);
            return { user: candidate, enrollmentRequired: true };
        }

        const totpError = MonitorAuth.verifyTotp(login, secret, totp || "");
        if (totpError) {
            MonitorAuth.registerFailure(login);
            return { error: totpError };
        }

        MonitorAuth.clearFailures(login);
        return { user: candidate };
    }

    // ---- 2FA enrollment ----
    // Trust-on-first-use: whoever knows the password enrols the authenticator. Re-enrollment is
    // deliberately NOT possible here — otherwise a stolen password would let an attacker swap the
    // second factor. Resetting requires removing the record from the store by hand.
    private static pendingEnrollments = new Map<string, { login: string; secret: string; createdAt: number }>();
    static ENROLLMENT_TTL_MS = 10 * 60 * 1000;

    // `label`: the name the authenticator app shows (the login without a realm prefix such as "doc:").
    static beginEnrollment(login: string, issuer = "Monitor", label = login): { token: string, secret: string, uri: string } {
        const now = Date.now();
        for (const [t, p] of MonitorAuth.pendingEnrollments)
            if (now - p.createdAt > MonitorAuth.ENROLLMENT_TTL_MS) MonitorAuth.pendingEnrollments.delete(t);

        const { secret, uri } = MonitorAuth.generateTotpSecret(label, issuer);
        const token = crypto.randomBytes(32).toString("hex");
        MonitorAuth.pendingEnrollments.set(token, { login, secret, createdAt: now });
        return { token, secret, uri };
    }

    /** The secret is stored only after a correct code proves the authenticator really has it. */
    static completeEnrollment(token: string, code: string): { login?: string, error?: string } {
        const pending = MonitorAuth.pendingEnrollments.get(token);
        if (!pending)
            return { error: "enrollment session expired, start again" };
        if (Date.now() - pending.createdAt > MonitorAuth.ENROLLMENT_TTL_MS) {
            MonitorAuth.pendingEnrollments.delete(token);
            return { error: "enrollment session expired, start again" };
        }
        if (MonitorAuth.enrolled.has(pending.login))
            return { error: "already enrolled" };

        const err = MonitorAuth.verifyTotp(pending.login, pending.secret, code);
        if (err) return { error: err };

        const rec = { secret: pending.secret, enrolledAt: Date.now(), lastCounter: 0 };
        MonitorAuth.pendingEnrollments.delete(token);
        if (MonitorAuth.authFile) {
            if (!MonitorAuth.saveEnrollment(pending.login, rec))
                return { error: "cannot save the enrollment on the server, try again later" };
        } else {
            MonitorAuth.enrolled.set(pending.login, rec);
        }
        logInfo(`Monitor 2FA enrolled for "${pending.login}"`, "MonitorAuth");
        return { login: pending.login };
    }

    // ---- sessions ----

    private static purgeSessions(now: number) {
        for (const [token, s] of MonitorAuth.sessions) {
            if (now - s.lastSeenAt > MonitorAuth.SESSION_IDLE_MS || now - s.createdAt > MonitorAuth.SESSION_MAX_MS)
                MonitorAuth.sessions.delete(token);
        }
    }

    static createSession(login: string): IMonitorSession {
        const now = Date.now();
        MonitorAuth.purgeSessions(now);
        const session: IMonitorSession = {
            token: crypto.randomBytes(32).toString("hex"),
            login, createdAt: now, lastSeenAt: now,
        };
        MonitorAuth.sessions.set(session.token, session);
        return session;
    }

    /** Returns the session and slides the idle window, or null when absent/expired. */
    static touchSession(token: string): IMonitorSession | null {
        const now = Date.now();
        MonitorAuth.purgeSessions(now);
        const s = MonitorAuth.sessions.get(token);
        if (!s) return null;
        s.lastSeenAt = now;
        return s;
    }

    static revokeSession(token: string) {
        MonitorAuth.sessions.delete(token);
    }

    static revokeAllFor(login: string) {
        for (const [token, s] of MonitorAuth.sessions)
            if (s.login === login) MonitorAuth.sessions.delete(token);
    }
}
