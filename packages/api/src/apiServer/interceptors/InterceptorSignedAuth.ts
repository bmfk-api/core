import crypto from "crypto";
import fs from "fs";
import { IInterceptor } from "../APIService";
import { JSONStableStringify } from "../helper/JSONStableStringify";
import DefaultErrors from "../structures/DefaultErrors";
import { IRequest } from "../structures/Interfaces";

// Request signing with Ed25519 key pairs: the client holds the private key, the server only the
// public one — so nothing on the server can be stolen and replayed (unlike an HMAC key or a
// password hash used as a bearer).
//
//   Authorization: Signature kid="<key id>", ts="<epoch ms>", nonce="<random>", sig="<base64>"
//
// The signature covers, one per line:
//   bmfk-sig-v1 · METHOD · URL path · ts · nonce · sha256(stable JSON of { data, files })
// where `data` is the request's fields as sent (JSON or form body, plus query) and `files` maps
// every uploaded field to the sha256 of its content. So a captured request can't be replayed
// (nonce), reused later (ts window), or pointed at another path, other fields or another file.
//
// Keys are base64 DER: the public key as SPKI ("MCowBQYDK2VwAyEA…"), the private one as PKCS#8.

export interface ISignedAuthResult { kid: string }

export interface ISignedAuthVerdict {
    present: boolean;     // a Signature header was sent at all
    kid?: string;         // verified key id
    error?: string;       // why it failed (for the server log — the caller decides what to reveal)
}

const SCHEME = "signature ";
const VERSION = "bmfk-sig-v1";

export class InterceptorSignedAuth implements IInterceptor<ISignedAuthResult> {

    // Same window as InterceptorPayAuth: a little skew into the future, a tight past — the past
    // bound is what limits how long a captured request stays usable.
    static TS_PAST_SEC = 300;
    static TS_FUTURE_SEC = 60;
    private static readonly NONCE_MAX = 100_000;

    // kid:nonce → epoch ms after which it may be forgotten. Same TTL for all, so insertion order
    // is expiry order. Shared by every instance in the process.
    private static nonceSeen = new Map<string, number>();
    // Nonces whose check is still running (key lookup, file hashing): a parallel copy is refused.
    private static nonceChecking = new Set<string>();

    // resolveKey(kid) → that key's public key (base64 SPKI), or null when the kid is unknown.
    constructor(private resolveKey: (kid: string) => Promise<string | null | undefined> | string | null | undefined) {}

    // ---- server ----

    async intercept(req: IRequest): Promise<ISignedAuthResult> {
        const v = await this.verify(req);
        if (!v.kid) throw { ...DefaultErrors.UNAUTHORIZED, details: v.present ? "Invalid signature" : "Signature required" };
        return { kid: v.kid };
    }

    async verify(req: IRequest): Promise<ISignedAuthVerdict> {
        const header = String(req.headers?.["authorization"] ?? "");
        if (!header.toLowerCase().startsWith(SCHEME)) return { present: false };

        const p = InterceptorSignedAuth.parseHeader(header.slice(SCHEME.length));
        if (!p.kid || !p.ts || !p.nonce || !p.sig) return { present: true, error: "malformed Signature header" };
        if (!/^[A-Za-z0-9._@-]{1,128}$/.test(p.kid)) return { present: true, error: "malformed key id" };
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(p.nonce)) return { present: true, error: "malformed nonce" };
        if (!/^\d{13}$/.test(p.ts)) return { present: true, error: "ts must be epoch milliseconds (13 digits)" };

        const now = Date.now();
        const delta = Math.round((Number(p.ts) - now) / 1000);
        if (delta < -InterceptorSignedAuth.TS_PAST_SEC || delta > InterceptorSignedAuth.TS_FUTURE_SEC)
            return { present: true, error: `ts out of window: off by ${delta}s — check the client's clock` };

        InterceptorSignedAuth.purge(now);
        const nonceKey = p.kid + ":" + p.nonce;
        if (InterceptorSignedAuth.nonceSeen.has(nonceKey) || InterceptorSignedAuth.nonceChecking.has(nonceKey))
            return { present: true, error: "nonce already used (replayed request)" };
        InterceptorSignedAuth.nonceChecking.add(nonceKey);
        try {
            return await this.check(req, p, now, nonceKey);
        } finally {
            InterceptorSignedAuth.nonceChecking.delete(nonceKey);
        }
    }

    private async check(req: IRequest, p: Record<string, string>, now: number, nonceKey: string): Promise<ISignedAuthVerdict> {
        const publicKey = await this.resolveKey(p.kid);
        if (!publicKey) return { present: true, error: `unknown key id "${p.kid}"` };

        let key: crypto.KeyObject;
        try { key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }); }
        catch { return { present: true, error: `the public key of "${p.kid}" is not a valid Ed25519 key` }; }

        const raw: any = req.raw ?? {};
        const path = InterceptorSignedAuth.pathOf(raw.originalUrl ?? raw.url ?? req.endpoint ?? "");
        const files: Record<string, string> = {};
        for (const [field, f] of Object.entries((raw.files ?? {}) as Record<string, any>)) {
            // One hash per field is signed, so one file per field: the handler would get every file.
            if (Array.isArray(f) && f.length !== 1) return { present: true, error: `field "${field}" holds ${f.length} files — one file per field` };
            const one = Array.isArray(f) ? f[0] : f;
            files[field] = await InterceptorSignedAuth.hashUpload(one);
        }
        const data = { ...(raw.body ?? {}), ...(raw.query ?? {}) };
        const message = InterceptorSignedAuth.message(String(req.method ?? raw.method ?? "").toUpperCase(), path, p.ts, p.nonce, data, files);

        let ok = false;
        try { ok = crypto.verify(null, Buffer.from(message), key, Buffer.from(p.sig, "base64")); } catch { ok = false; }
        if (!ok) return { present: true, error: "signature does not match (wrong key, or the request was changed)" };

        // Burnt only after a valid signature: otherwise anyone could spend a client's nonce.
        InterceptorSignedAuth.nonceSeen.set(nonceKey, now + (InterceptorSignedAuth.TS_PAST_SEC + InterceptorSignedAuth.TS_FUTURE_SEC) * 1000);
        return { present: true, kid: p.kid };
    }

    private static purge(now: number) {
        const seen = InterceptorSignedAuth.nonceSeen;
        for (const [k, exp] of seen) { if (exp > now) break; seen.delete(k); }
        while (seen.size > InterceptorSignedAuth.NONCE_MAX) {
            const oldest = seen.keys().next().value;
            if (oldest === undefined) break;
            seen.delete(oldest);
        }
    }

    static parseHeader(s: string): Record<string, string> {
        const out: Record<string, string> = {};
        for (const part of s.split(",")) {
            const eq = part.indexOf("=");
            if (eq < 1) continue;
            let v = part.slice(eq + 1).trim();
            if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
            out[part.slice(0, eq).trim().toLowerCase()] = v;
        }
        return out;
    }

    private static async hashUpload(f: any): Promise<string> {
        if (f?.tempFilePath) return InterceptorSignedAuth.sha256File(f.tempFilePath);
        return crypto.createHash("sha256").update(f?.data ?? Buffer.alloc(0)).digest("hex");
    }

    // ---- shared by both sides ----

    static pathOf(url: string): string {
        try { return new URL(url, "http://localhost").pathname; } catch { return url; }
    }

    static message(method: string, path: string, ts: string, nonce: string, data: unknown, files: Record<string, string>): string {
        // Through JSON first: the client hashes what it actually sends (undefined fields vanish).
        const payload = JSONStableStringify(JSON.parse(JSON.stringify({ data: data ?? {}, files })));
        const digest = crypto.createHash("sha256").update(payload).digest("hex");
        return [VERSION, method, path, ts, nonce, digest].join("\n");
    }

    static sha256File(file: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const h = crypto.createHash("sha256");
            fs.createReadStream(file).on("data", d => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
        });
    }

    // ---- client ----

    /** A fresh Ed25519 key pair, base64 DER: publicKey for the server, privateKey for the client. */
    static generateKeyPair(): { publicKey: string, privateKey: string } {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
        return {
            publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
            privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
        };
    }

    /** The public key that belongs to a private one — to check a pair, or to print it again. */
    static publicKeyOf(privateKey: string): string {
        const key = crypto.createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
        return crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
    }

    /**
     * The Authorization header for one request. `data` is exactly the fields sent (JSON body or
     * form fields); `files` maps form field → sha256 of the uploaded content. `nonce` is generated
     * when omitted; pass one when the caller needs to know it (a signed answer bound to it).
     */
    static sign(o: { privateKey: string, kid: string, method: string, url: string, data?: unknown, files?: Record<string, string>, nonce?: string }): string {
        const key = crypto.createPrivateKey({ key: Buffer.from(o.privateKey, "base64"), format: "der", type: "pkcs8" });
        const ts = String(Date.now());
        const nonce = o.nonce ?? crypto.randomBytes(18).toString("base64url");
        const message = InterceptorSignedAuth.message(o.method.toUpperCase(), InterceptorSignedAuth.pathOf(o.url), ts, nonce, o.data ?? {}, o.files ?? {});
        const sig = crypto.sign(null, Buffer.from(message), key).toString("base64");
        return `Signature kid="${o.kid}", ts="${ts}", nonce="${nonce}", sig="${sig}"`;
    }
}
