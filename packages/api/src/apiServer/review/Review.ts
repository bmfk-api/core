import fs from "fs";
import path from "path";
import { APIServiceOptions } from "../APIService";
import { BaseEndpoint } from "../BaseEndpoint";
import { logInfo, logWarn } from "../LogService";
import { IRequest, IResponse } from "../structures/Interfaces";
import DefaultErrors from "../structures/DefaultErrors";
import { DeployerService } from "../deployment/DeployerService";
import { IPendingReview } from "../deployment/ReviewStore";
import { ReviewAuth } from "./ReviewAuth";
import { ReviewDiff } from "./ReviewDiff";

// Deploy review: the page a reviewer opens from the emailed link, and its API.
//   <baseEndPoint>review/html        the page (one self-contained file)
//   review/info      {token}         what the link points at — no secrets, nothing to act on
//   review/login     {token, login, password, totp?}
//   review/enroll2fa {enrollmentToken, totp}
//   review/details   Bearer session  the upload and every reviewer's decision
//   review/diff      Bearer session  what changes against the last deployed archive
//   review/decide    Bearer session  {decision: accept|decline}
//   review/logout    Bearer session
// Everything sits behind the deployer's allowed_ips: reviewers come in over the VPN.
export class Review extends BaseEndpoint {

    ignoreInDocumentation = true;
    private indexHtmlFile: string | null = null;
    private auth: ReviewAuth;

    constructor(private deployer: DeployerService, private apiServiceOptions: APIServiceOptions) {
        super("review");
        this.auth = new ReviewAuth(deployer.reviews, () => (deployer.setup?.reviewers ?? []) as any,
            `${apiServiceOptions.projectName || "Deployer"} review`);
        // Bodies carry link tokens, passwords and TOTP codes: kept out of the request log.
        this.registerEndpoints([
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "html", handler: this.html },
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "info", handler: this.info, validationModel: { token: "" } },
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "login", handler: this.login,
              validationModel: { token: "", login: "", password: "", totp: "", $__totp_optional: true } },
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "enroll2fa", handler: this.enroll2fa,
              validationModel: { enrollmentToken: "", totp: "" } },
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "details", handler: this.details },
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "diff", handler: this.diff },
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "decide", handler: this.decide,
              validationModel: { decision: "", $__decision_values: ["accept", "decline"] } },
            { ignoreInterceptor: true, ignoreHttpLogging: true, endpoint: "logout", handler: this.logout },
        ]);
    }

    private gate(req: IRequest) {
        if (!this.deployer.isIpAllowed(req.ip)) {
            logWarn(`Review: request refused from ${req.ip ?? "unknown"} — not in allowed_ips`);
            throw { ...DefaultErrors.FORBIDDEN };
        }
    }

    private session(req: IRequest) {
        const token = String(req.headers["authorization"] ?? "").split(" ").pop() ?? "";
        const { session, pending, error } = this.auth.touch(token);
        if (!session || !pending) throw { ...DefaultErrors.UNAUTHORIZED, details: error ?? "Sign in again." };
        return { session, pending };
    }

    // What the page may show: never token hashes, never the archive path.
    private static view(p: IPendingReview, me?: string) {
        return {
            project: p.project, state: p.state, result: p.result ?? null,
            uploadedBy: p.uploadedBy, uploadedAt: p.uploadedAt, expiresAt: p.expiresAt,
            mode: p.mode, sha256: p.sha256, size: p.size,
            reviewers: Object.entries(p.reviewers).map(([login, r]) => ({ login, decision: r.decision, at: r.at })),
            you: me ?? null,
        };
    }

    async html(req: IRequest): Promise<IResponse> {
        this.gate(req);
        if (!this.indexHtmlFile) {
            let base = this.apiServiceOptions.baseEndPoint;
            if (!base.endsWith("/")) base += "/";
            const title = `${this.apiServiceOptions.projectName || "Deployer"} — deploy review`;
            const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
            this.indexHtmlFile = fs.readFileSync(path.resolve(__dirname, "index.html"), "utf-8")
                .replace(/{{host}}/g, esc(base + "review/"))
                .replace(/{{title}}/g, esc(title));
        }
        return {
            rawResponse: true,
            data: this.indexHtmlFile,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": Buffer.byteLength(this.indexHtmlFile).toString(),
                // The link token lives in the URL fragment; nothing may carry it elsewhere.
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
                "X-Frame-Options": "DENY",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            }
        } as IResponse;
    }

    async info(req: IRequest): Promise<IResponse> {
        this.gate(req);
        const link = this.deployer.reviews.findByToken(String(req.data.token ?? ""));
        if (!link) throw { ...DefaultErrors.NOT_FOUND, details: "This link is invalid, expired or was replaced by a newer upload." };
        const v = Review.view(link.pending, link.reviewer);
        // Before sign-in: enough to recognise the request, nothing about other reviewers.
        return { data: { project: v.project, state: v.state, result: v.result, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt, expiresAt: v.expiresAt, mode: v.mode, reviewer: link.reviewer } };
    }

    async login(req: IRequest): Promise<IResponse> {
        this.gate(req);
        const r = await this.auth.login(req.data.token, req.data.login, req.data.password, req.data.totp);
        if (r.error) {
            logWarn(`Review sign-in failed for "${String(req.data.login).slice(0, 64)}" from ${req.ip ?? "unknown"}: ${r.error}`);
            throw { ...DefaultErrors.UNAUTHORIZED, details: r.error };
        }
        if (r.enrollment) return { data: { enrollmentRequired: true, ...r.enrollment } };
        logInfo(`Review sign-in: "${r.session!.login}" for "${r.session!.project}" from ${req.ip ?? "unknown"}`);
        return { data: { token: r.session!.token, idleTimeoutMs: ReviewAuth.SESSION_IDLE_MS } };
    }

    async enroll2fa(req: IRequest): Promise<IResponse> {
        this.gate(req);
        const r = this.auth.enroll(req.data.enrollmentToken, req.data.totp);
        if (r.error) throw { ...DefaultErrors.UNAUTHORIZED, details: r.error };
        logInfo(`Review 2FA enrolled for "${r.session!.login}" from ${req.ip ?? "unknown"}`);
        return { data: { token: r.session!.token, idleTimeoutMs: ReviewAuth.SESSION_IDLE_MS } };
    }

    async details(req: IRequest): Promise<IResponse> {
        this.gate(req);
        const { session, pending } = this.session(req);
        return { data: Review.view(pending, session.login) };
    }

    async diff(req: IRequest): Promise<IResponse> {
        this.gate(req);
        const { pending } = this.session(req);
        const store = this.deployer.reviews;
        const archive = store.archivePath(pending.project);
        if (pending.state !== "pending" || !fs.existsSync(archive))
            return { data: { unavailable: "The upload is no longer waiting for review — its archive was removed." } };
        const baseline = fs.existsSync(store.lastArchivePath(pending.project)) ? store.lastArchivePath(pending.project) : null;
        try {
            return { data: await ReviewDiff.compute(baseline, archive) };
        } catch (e: any) {
            logWarn(`Review diff for "${pending.project}" failed: ${e?.message ?? e}`);
            return { data: { unavailable: "Can't compare the archives: " + String(e?.message ?? e).slice(0, 300) } };
        }
    }

    async decide(req: IRequest): Promise<IResponse> {
        this.gate(req);
        const { session } = this.session(req);
        const r = await this.deployer.reviewDecide(session.project, session.sha256, session.login, req.data.decision, req.ip ?? null);
        if (r.error || !r.pending) throw { ...DefaultErrors.BAD_REQUEST, details: r.error ?? "Can't record the decision." };
        return { data: Review.view(r.pending, session.login) };
    }

    async logout(req: IRequest): Promise<IResponse> {
        this.auth.logout(String(req.headers["authorization"] ?? "").split(" ").pop() ?? "");
        return { data: true };
    }
}
