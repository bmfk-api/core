import fs from "fs";
import path from "path";
import crypto from "crypto";
import { MonitorAuth } from "../monitor/MonitorAuth";
import { PasswordHash } from "../helper/PasswordHash";
import { IPendingReview, ReviewStore } from "../deployment/ReviewStore";
import { logError } from "../LogService";

export interface IReviewer { login: string, password: string, email: string }

export interface IReviewSession {
    token: string;
    login: string;
    project: string;
    sha256: string;      // the archive this session may decide on
    linkHash: string;    // the link it came from — a re-issued link ends the session
    createdAt: number;
    lastSeenAt: number;
}

// Sign-in for deploy reviewers: the personal link alone is not enough — login, password and a TOTP
// code are required. 2FA is enrolled at the first sign-in (trust on first use, like the monitor).
//
// Enrollments live in <projects_path>/.review/reviewers-2fa.json (0600) and are read on every
// sign-in, so deleting a reviewer's entry resets their 2FA at once.
export class ReviewAuth {
    static SESSION_IDLE_MS = 15 * 60 * 1000;
    static SESSION_MAX_MS = 60 * 60 * 1000;
    static ENROLLMENT_TTL_MS = 10 * 60 * 1000;
    static MAX_FAILED_ATTEMPTS = 10;
    static LOCKOUT_MS = 30 * 60 * 1000;

    private sessions = new Map<string, IReviewSession>();
    private enrollments = new Map<string, { login: string, secret: string, link: { project: string, sha256: string, linkHash: string }, createdAt: number }>();
    private failures = new Map<string, { count: number, lockedUntil: number }>();
    private readonly totpFile: string;

    constructor(private store: ReviewStore, private reviewers: () => IReviewer[], private issuer = "Deploy review") {
        this.totpFile = path.join(store.dir, "reviewers-2fa.json");
    }

    // ---- 2FA store ----

    // Only a missing file means "nobody enrolled yet". An unreadable or damaged one throws: read as
    // empty, it would offer every reviewer a fresh enrollment and then overwrite the real secrets.
    private readSecrets(): Record<string, { secret: string, enrolledAt: number }> {
        let text: string;
        try { text = fs.readFileSync(this.totpFile, "utf-8"); }
        catch (e: any) {
            if (e?.code === "ENOENT") return {};
            throw new Error(`reviewers' 2FA store ${this.totpFile} can't be read (${e?.code ?? e})`);
        }
        let doc: any;
        try { doc = JSON.parse(text); } catch { doc = null; }
        if (!doc || typeof doc.users !== "object" || !doc.users || Array.isArray(doc.users))
            throw new Error(`reviewers' 2FA store ${this.totpFile} is damaged`);
        return doc.users;
    }

    private secretFor(login: string): string | null {
        const r = this.readSecrets()[login];
        return r && typeof r.secret === "string" && r.secret.length > 0 ? r.secret : null;
    }

    private saveSecret(login: string, secret: string) {
        fs.mkdirSync(path.dirname(this.totpFile), { recursive: true, mode: 0o700 });
        const users = this.readSecrets();
        users[login] = { secret, enrolledAt: Date.now() };
        const tmp = this.totpFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, users }, null, 2), { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tmp, this.totpFile);
    }

    // ---- lockout ----

    private lockedFor(login: string): number {
        const f = this.failures.get(login);
        return f && f.lockedUntil > Date.now() ? f.lockedUntil - Date.now() : 0;
    }

    private fail(login: string) {
        const f = this.failures.get(login) ?? { count: 0, lockedUntil: 0 };
        f.count++;
        if (f.count >= ReviewAuth.MAX_FAILED_ATTEMPTS) { f.lockedUntil = Date.now() + ReviewAuth.LOCKOUT_MS; f.count = 0; }
        this.failures.set(login, f);
    }

    // ---- sign-in ----

    // The link token decides which deploy and which reviewer; the credentials must be that reviewer's.
    async login(linkToken: string, login: string, password: string, totp?: string)
        : Promise<{ session?: IReviewSession, enrollment?: { enrollmentToken: string, secret: string, otpauthUri: string, expiresInMs: number }, error?: string }> {
        const link = this.store.findByToken(linkToken);
        if (!link) return { error: "This link is invalid, expired or was replaced by a newer upload." };

        login = String(login ?? "").trim();
        const locked = this.lockedFor(login);
        if (locked > 0) return { error: `Account locked, try again in ${Math.ceil(locked / 60000)} min.` };

        // One generic answer for a wrong login, a wrong password or someone else's link.
        const reviewer = this.reviewers().find(r => r.login === login);
        const passwordOk = reviewer && link.reviewer === login && PasswordHash.isHash(reviewer.password)
            && await PasswordHash.verify(String(password ?? ""), reviewer.password);
        if (!passwordOk) {
            this.fail(login);
            return { error: "Invalid login or password." };
        }

        const bound = { project: link.pending.project, sha256: link.pending.sha256, linkHash: link.pending.reviewers[login].tokenHash };
        let secret: string | null;
        try { secret = this.secretFor(login); }
        catch (e: any) {
            logError(`Review sign-in of "${login}" refused: ${e?.message ?? e} — restore the file from a backup; no new enrollment is offered meanwhile`);
            return { error: "Sign-in is unavailable: the 2FA store needs the operator's attention." };
        }
        if (!secret) {
            const now = Date.now();
            for (const [t, e] of this.enrollments) if (now - e.createdAt > ReviewAuth.ENROLLMENT_TTL_MS) this.enrollments.delete(t);
            const { secret: fresh, uri } = MonitorAuth.generateTotpSecret(login, this.issuer);
            const enrollmentToken = crypto.randomBytes(32).toString("hex");
            this.enrollments.set(enrollmentToken, { login, secret: fresh, link: bound, createdAt: now });
            return { enrollment: { enrollmentToken, secret: fresh, otpauthUri: uri, expiresInMs: ReviewAuth.ENROLLMENT_TTL_MS } };
        }

        const totpError = MonitorAuth.verifyTotp("review:" + login, secret, String(totp ?? ""));
        if (totpError) {
            this.fail(login);
            return { error: totpError };
        }
        this.failures.delete(login);
        return { session: this.createSession(login, bound) };
    }

    enroll(enrollmentToken: string, totp: string): { session?: IReviewSession, error?: string } {
        const e = this.enrollments.get(String(enrollmentToken ?? ""));
        if (!e || Date.now() - e.createdAt > ReviewAuth.ENROLLMENT_TTL_MS) {
            this.enrollments.delete(String(enrollmentToken ?? ""));
            return { error: "Enrollment expired — sign in again." };
        }
        // Someone may have enrolled meanwhile (another tab): never overwrite an existing secret.
        try {
            if (this.secretFor(e.login)) {
                this.enrollments.delete(enrollmentToken);
                return { error: "2FA is already set up for this reviewer — sign in with your code." };
            }
        } catch (err: any) {
            logError(`Review 2FA enrollment of "${e.login}" refused: ${err?.message ?? err}`);
            return { error: "Sign-in is unavailable: the 2FA store needs the operator's attention." };
        }
        const err = MonitorAuth.verifyTotp("review:" + e.login, e.secret, String(totp ?? ""));
        if (err) return { error: err };
        this.saveSecret(e.login, e.secret);
        this.enrollments.delete(enrollmentToken);
        this.failures.delete(e.login);
        return { session: this.createSession(e.login, e.link) };
    }

    // ---- sessions ----

    private createSession(login: string, link: { project: string, sha256: string, linkHash: string }): IReviewSession {
        const now = Date.now();
        for (const [t, s] of this.sessions)
            if (now - s.lastSeenAt > ReviewAuth.SESSION_IDLE_MS || now - s.createdAt > ReviewAuth.SESSION_MAX_MS) this.sessions.delete(t);
        const session: IReviewSession = { token: crypto.randomBytes(32).toString("hex"), login, ...link, createdAt: now, lastSeenAt: now };
        this.sessions.set(session.token, session);
        return session;
    }

    // A session is only good for the exact upload it was opened for: a newer upload, a re-issued
    // link or an expired record ends it.
    touch(token: string): { session?: IReviewSession, pending?: IPendingReview, error?: string } {
        const s = this.sessions.get(String(token ?? ""));
        const now = Date.now();
        if (!s || now - s.lastSeenAt > ReviewAuth.SESSION_IDLE_MS || now - s.createdAt > ReviewAuth.SESSION_MAX_MS) {
            if (s) this.sessions.delete(s.token);
            return { error: "Session expired — sign in again." };
        }
        const pending = this.store.get(s.project);
        if (!pending || pending.sha256 !== s.sha256 || pending.reviewers[s.login]?.tokenHash !== s.linkHash) {
            this.sessions.delete(s.token);
            return { error: "This upload was replaced or removed — open the newest link from your email." };
        }
        s.lastSeenAt = now;
        return { session: s, pending };
    }

    logout(token: string) {
        this.sessions.delete(String(token ?? ""));
    }
}
