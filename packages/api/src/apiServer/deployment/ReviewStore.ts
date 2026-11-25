import fs from "fs";
import path from "path";
import crypto from "crypto";
import { UploadedFile } from "express-fileupload";
import { logError } from "../LogService";

// Deploys that wait for a reviewer's decision, one per project, under <projects_path>/.review/:
//   <project>.pending.tgz   the uploaded archive, exactly as received (0600)
//   <project>.pending.json  who uploaded it, its SHA-256, the reviewers and their decisions (0600)
//   <project>.last.tgz      the raw archive of the last successful deploy — the "before" of a diff.
//                           Raw on purpose: deployed folders have config values (secrets) substituted.
// A new upload replaces the pending one and re-issues every link, so older links stop working.

export interface IReviewDecision {
    tokenHash: string;               // sha256 of the link token; the token itself is never stored
    decision: "accept" | "decline" | null;
    at: number | null;
    ip: string | null;
}

export type TReviewState = "pending" | "deploying" | "deployed" | "failed" | "declined" | "expired";

export interface IPendingReview {
    project: string;
    state: TReviewState;
    result?: { at: number, message: string, slot?: string | null, activeThisDeploy?: boolean };
    sha256: string;                  // of the archive — what is approved is exactly what gets deployed
    size: number;
    uploadedBy: string;
    uploadedFrom: string | null;
    uploadedAt: number;
    expiresAt: number;
    mode: "any" | "all";
    reviewers: Record<string, IReviewDecision>;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export class ReviewStore {
    readonly dir: string;

    constructor(projectsPath: string) {
        this.dir = path.resolve(projectsPath, ".review");
    }

    static hashToken(token: string): string {
        return crypto.createHash("sha256").update(String(token)).digest("hex");
    }

    private file(project: string, kind: "pending.tgz" | "pending.json" | "last.tgz" | "incoming.tgz"): string {
        if (!NAME_RE.test(project)) throw new Error("invalid project name");
        return path.join(this.dir, `${project}.${kind}`);
    }

    archivePath(project: string): string { return this.file(project, "pending.tgz"); }
    lastArchivePath(project: string): string { return this.file(project, "last.tgz"); }

    private ensureDir() {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }

    private static sha256File(file: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const h = crypto.createHash("sha256");
            fs.createReadStream(file).on("data", d => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
        });
    }

    private writeJson(file: string, value: unknown) {
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tmp, file);
    }

    // Stores a new pending deploy (replacing any previous one) and returns one fresh link token per
    // reviewer. The archive is moved in first and the record written last, so a crash in between
    // leaves no record pointing at a missing or half-written archive.
    async create(project: string, file: UploadedFile, meta: { uploadedBy: string, uploadedFrom: string | null, mode: "any" | "all", reviewers: string[], ttlMs: number })
        : Promise<{ pending: IPendingReview, tokens: Record<string, string>, replaced: boolean }> {
        this.ensureDir();
        const replaced = this.get(project) !== null;
        this.remove(project);

        const archive = this.archivePath(project);
        await new Promise<void>((resolve, reject) => file.mv(archive, (err: any) => err ? reject(err) : resolve()));
        fs.chmodSync(archive, 0o600);

        const tokens: Record<string, string> = {};
        const reviewers: Record<string, IReviewDecision> = {};
        for (const login of meta.reviewers) {
            const token = crypto.randomBytes(32).toString("base64url");
            tokens[login] = token;
            reviewers[login] = { tokenHash: ReviewStore.hashToken(token), decision: null, at: null, ip: null };
        }
        const now = Date.now();
        const pending: IPendingReview = {
            project,
            state: "pending",
            sha256: await ReviewStore.sha256File(archive),
            size: fs.statSync(archive).size,
            uploadedBy: meta.uploadedBy,
            uploadedFrom: meta.uploadedFrom,
            uploadedAt: now,
            expiresAt: now + meta.ttlMs,
            mode: meta.mode,
            reviewers,
        };
        this.writeJson(this.file(project, "pending.json"), pending);
        return { pending, tokens, replaced };
    }

    get(project: string): IPendingReview | null {
        try {
            const p = JSON.parse(fs.readFileSync(this.file(project, "pending.json"), "utf-8"));
            return p && typeof p === "object" && p.project === project ? p as IPendingReview : null;
        } catch {
            return null;
        }
    }

    save(pending: IPendingReview) {
        this.writeJson(this.file(pending.project, "pending.json"), pending);
    }

    // Which pending deploy and reviewer a link token belongs to. Expired records don't match.
    findByToken(token: string): { pending: IPendingReview, reviewer: string } | null {
        if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
        const hash = Buffer.from(ReviewStore.hashToken(token), "hex");
        let entries: string[];
        try { entries = fs.readdirSync(this.dir); } catch { return null; }
        for (const f of entries) {
            if (!f.endsWith(".pending.json")) continue;
            const pending = this.get(f.slice(0, -".pending.json".length));
            if (!pending || pending.expiresAt < Date.now()) continue;
            for (const [login, r] of Object.entries(pending.reviewers)) {
                const stored = Buffer.from(String(r.tokenHash), "hex");
                if (stored.length === hash.length && crypto.timingSafeEqual(stored, hash))
                    return { pending, reviewer: login };
            }
        }
        return null;
    }

    // True when the stored archive is still the one the record (and so the reviewers) refer to.
    async archiveIntact(pending: IPendingReview): Promise<boolean> {
        try { return (await ReviewStore.sha256File(this.archivePath(pending.project))) === pending.sha256; }
        catch { return false; }
    }

    // Append-only audit trail per project: who uploaded what (by hash), who decided, how it ended.
    // Rotated at 1 MB (the previous file is kept as .1).
    journal(project: string, event: string, details: Record<string, unknown>) {
        const entry = JSON.stringify({ at: new Date().toISOString(), event, ...details });
        try {
            this.ensureDir();
            const file = path.join(this.dir, `${project}.history.jsonl`);
            if (!NAME_RE.test(project)) throw new Error("invalid project name");
            try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + ".1"); } catch { /* no file yet */ }
            fs.appendFileSync(file, entry + "\n", { encoding: "utf-8", mode: 0o600 });
        } catch (e: any) {
            // The audit trail must never break a deploy decision — but the entry must not vanish either.
            logError(`Review journal of "${project}" not written (${e?.message ?? e}): ${entry}`);
        }
    }

    // The archive is only needed while a decision is open; the record stays for the page to show.
    dropArchive(project: string) {
        try { fs.rmSync(this.archivePath(project), { force: true }); } catch { /* already gone */ }
    }

    // Undecided uploads past their deadline: the archive goes, the record says "expired".
    sweep(): string[] {
        const expired: string[] = [];
        let entries: string[];
        try { entries = fs.readdirSync(this.dir); } catch { return expired; }
        for (const f of entries) {
            if (!f.endsWith(".pending.json")) continue;
            const pending = this.get(f.slice(0, -".pending.json".length));
            if (!pending || pending.state !== "pending" || pending.expiresAt >= Date.now()) continue;
            pending.state = "expired";
            pending.result = { at: Date.now(), message: "Nobody decided in time — upload again to restart the review." };
            this.save(pending);
            this.dropArchive(pending.project);
            this.journal(pending.project, "expired", { sha256: pending.sha256 });
            expired.push(pending.project);
        }
        return expired;
    }

    remove(project: string) {
        for (const kind of ["pending.json", "pending.tgz"] as const)
            try { fs.rmSync(this.file(project, kind), { force: true }); } catch { /* already gone */ }
    }

    // The raw archive of a deploy in progress becomes the baseline only once that deploy succeeded.
    stageBaseline(project: string, archive: string) {
        this.ensureDir();
        const incoming = this.file(project, "incoming.tgz");
        fs.copyFileSync(archive, incoming);
        fs.chmodSync(incoming, 0o600);
    }

    commitBaseline(project: string) {
        try { fs.renameSync(this.file(project, "incoming.tgz"), this.lastArchivePath(project)); } catch { /* nothing staged */ }
    }

    dropStagedBaseline(project: string) {
        try { fs.rmSync(this.file(project, "incoming.tgz"), { force: true }); } catch { /* nothing staged */ }
    }
}
