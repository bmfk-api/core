
import crypto from "crypto";
import { IInterceptor } from "../APIService";
import { ValidationModel, Validator } from "../helper/Validator";
import DefaultErrors from "../structures/DefaultErrors";
import { IRequest } from "../structures/Interfaces";
import { logError } from "../LogService";


const _TAuthParams = {
	v: 0,
	ts: "",
	nonce: "",
	kid: "",
	alg: "",
	$__alg_optional: true,
	sig: ""
}
type TAuthParams = ValidationModel<typeof _TAuthParams>

// The signed message, one field per line:
//   bmfk-payauth-v1 · METHOD · URL path · kid · ts · nonce · b64
// Separators keep one field from sliding into the next (a glued "ts+nonce" lets ts digits move into
// the nonce with the same signature), and method, path and kid bind the request to its endpoint.
const VERSION = "bmfk-payauth-v1";


export class InterceptorPayAuth implements IInterceptor<any> {

	// Freshness window for `ts`. Asymmetric on purpose: we tolerate a little clock skew into the
	// future, but keep the past tight — the past bound is what limits how long a captured request
	// stays replayable.
	private static readonly TS_PAST_SEC = 300;
	private static readonly TS_FUTURE_SEC = 60;

	// A nonce only has to be remembered while a request carrying it could still pass the ts
	// window: a ts at the far future edge stays valid until now reaches ts + TS_PAST_SEC.
	private static readonly NONCE_TTL_MS = (InterceptorPayAuth.TS_PAST_SEC + InterceptorPayAuth.TS_FUTURE_SEC) * 1000;
	private static readonly NONCE_MAX = 100_000;   // hard cap, only to bound a flood inside the window

	// nonce -> epoch ms after which the entry may be dropped.
	private nonceSeen: Map<string, number> = new Map();

	private authorizationsPreset:{key:string,kid:string}[]|null|undefined;
	constructor(authorizations?:{key:string,kid:string}[]) {
		for (const a of authorizations ?? []) {
			const problem = InterceptorPayAuth.keyProblem(a.key);
			if (problem) throw new Error(`InterceptorPayAuth: key of "${a.kid}" ${problem}`);
		}
		this.authorizationsPreset = authorizations;
	}

	// Buffer.from(key, "hex") silently stops at the first non-hex character: a base64 key turns
	// into a few bytes or none at all, and an empty HMAC key lets anyone sign.
	private static keyProblem(key: unknown): string | null {
		if (typeof key !== "string" || !/^[0-9a-fA-F]*$/.test(key) || key.length % 2 !== 0)
			return "must be hex";
		if (key.length < 32)
			return "must be at least 16 bytes (32 hex characters)";
		return null;
	}

	// Every entry gets the SAME ttl, so insertion order equals expiry order and we can stop at the
	// first live one. (If ttl ever becomes per-entry, this early break must go.)
	private purgeNonces(nowMs: number) {
		for (const [nonce, expiresAt] of this.nonceSeen) {
			if (expiresAt > nowMs) break;
			this.nonceSeen.delete(nonce);
		}
		while (this.nonceSeen.size > InterceptorPayAuth.NONCE_MAX) {
			const oldest = this.nonceSeen.keys().next().value;
			if (oldest === undefined) break;
			this.nonceSeen.delete(oldest);
		}
	}

	async intercept(req: IRequest,authorizations?:{key:string,kid:string}[]): Promise<any> {
		
		const authScheme = "payauth "
		let headerData = req.headers["authorization"];
		if (!headerData)
			throw { ...DefaultErrors.UNAUTHORIZED, details: "No authorization header" }

		if (!headerData.toLowerCase().startsWith(authScheme))
			throw { ...DefaultErrors.UNAUTHORIZED, details: "wrong authorization scheme" }

		const b64 = req.data.b64;
		if (req.data.b64) {
			let json = null;
			try {
				json = Buffer.from(req.data.b64, "base64").toString("utf-8")
				json = JSON.parse(json);
			} catch (e) {
				throw { ...DefaultErrors.BAD_REQUEST, details: "JSON malformed" }
			}
			req.data = json;
		}


		const params = {} as TAuthParams;
		headerData.substring(authScheme.length).trim().split(",").forEach(v => {
			v = v.trim()
			// Split on the FIRST '=' only: a value may legitimately contain '=' (base64 padding),
			// and splitting on every '=' would silently drop the whole pair.
			const eq = v.indexOf("=");
			if (eq > 0) {
				const key = v.substring(0, eq).trim().toLowerCase();
				let value = v.substring(eq + 1).trim();
				if (value.length > 1 &&
					((value.startsWith("'") && value.endsWith("'")) ||
					 (value.startsWith('"') && value.endsWith('"')))) {
					value = value.substring(1, value.length - 1)
				}
				(params as any)[key] = value
			}
		});

		const errors = await Validator.validateStructure(_TAuthParams, params)
		if (errors)
			throw { ...DefaultErrors.UNAUTHORIZED, details: "Malformed authorization header", stack: errors }

		// `ts` is Unix epoch milliseconds (what Date.now() gives): an epoch has no timezone, so a
		// correct client in any zone produces the same number. One format only: never hand this to
		// Date.parse(), which would read a zone-less string as server-local time.
		if (!/^\d{13}$/.test(params.ts))
			throw { ...DefaultErrors.UNAUTHORIZED, details: "ts must be Unix epoch milliseconds (13 digits), UTC" }

		const nowMs = Date.now();
		const nowSec = Math.floor(nowMs / 1000);
		const tsSec = Math.floor(parseInt(params.ts, 10) / 1000);
		const delta = tsSec - nowSec;   // >0 — client is ahead of us
		if (delta < -InterceptorPayAuth.TS_PAST_SEC || delta > InterceptorPayAuth.TS_FUTURE_SEC)
			// The delta is deliberately echoed back: ts is the caller's own value, so nothing is
			// leaked, and the number tells an integrator what is wrong at a glance — a whole-hour
			// offset means a timezone bug, a ragged one means an unsynced clock.
			throw { ...DefaultErrors.UNAUTHORIZED, details: `ts out of window: off by ${delta}s (server epoch ${nowSec})` }

		this.purgeNonces(nowMs);
		if (this.nonceSeen.has(params.nonce))
			throw { ...DefaultErrors.UNAUTHORIZED, details: "Duplicate nonce" }

		if(!authorizations || authorizations.length === 0) {
			if(this.authorizationsPreset && this.authorizationsPreset.length > 0)
				authorizations = this.authorizationsPreset;
			else
				throw { ...DefaultErrors.UNAUTHORIZED, details: "No authorizations provided" }
		}

		for (let i of authorizations) {
			if (i.kid === params.kid) {
				// found key
				if (params.alg && params.alg.toLowerCase() === "hmac-sha256") {

					if (b64) {
						// Keys given per call skip the constructor's check.
						const problem = InterceptorPayAuth.keyProblem(i.key);
						if (problem) {
							logError(`InterceptorPayAuth: key of "${i.kid}" ${problem} — request refused`);
							throw { ...DefaultErrors.UNAUTHORIZED, details: "Key not usable" }
						}
						const key = Buffer.from(i.key, "hex")
						const message = InterceptorPayAuth.message(String(req.method ?? "").toUpperCase(), InterceptorPayAuth.pathOf(req), params.kid, params.ts, params.nonce, b64);
						const sig = crypto.createHmac("sha256", key).update(message).digest("hex")
						// Constant-time compare: a plain === leaks, through response timing, how
						// many leading characters of a guess were right. Length is not secret, so
						// checking it first (timingSafeEqual throws on unequal lengths) is fine.
						const got = Buffer.from(String(params.sig), "utf-8");
						const want = Buffer.from(sig, "utf-8");
						if (got.length === want.length && crypto.timingSafeEqual(got, want)) {
							// Burn the nonce only now: recording it before verification would let
							// anyone invalidate a legitimate client's nonce with a junk signature.
							this.nonceSeen.set(params.nonce, nowMs + InterceptorPayAuth.NONCE_TTL_MS);
							return i;
						}
						// Never echo the expected signature — that would hand out a valid one.
						throw { ...DefaultErrors.UNAUTHORIZED, details: "Signature mismatch" }
					} else {
						throw { ...DefaultErrors.UNAUTHORIZED, details: "Can't calc signature, no b64" }
					}

				} else {
					throw { ...DefaultErrors.UNAUTHORIZED, details: "Unsupported alg" }
				}
			}
		}

		throw { ...DefaultErrors.UNAUTHORIZED, details: "Key not found" }
	}

	static message(method: string, path: string, kid: string, ts: string, nonce: string, b64: string): string {
		return [VERSION, method, path, kid, ts, nonce, b64].join("\n");
	}

	private static pathOf(req: IRequest): string {
		const raw: any = req.raw ?? {};
		const url = String(raw.originalUrl ?? raw.url ?? req.endpoint ?? "");
		try { return new URL(url, "http://localhost").pathname; } catch { return url; }
	}

	/**
	 * Client side: the Authorization header and the `b64` field for one request. `key` is the shared
	 * key in hex, `data` the request body; send it as { b64 }.
	 */
	static sign(o: { key: string, kid: string, method: string, url: string, data: unknown, nonce?: string }): { authorization: string, b64: string } {
		const b64 = Buffer.from(JSON.stringify(o.data ?? {}), "utf-8").toString("base64");
		const ts = String(Date.now());
		const nonce = o.nonce ?? crypto.randomBytes(18).toString("base64url");
		const path = new URL(o.url, "http://localhost").pathname;
		const message = InterceptorPayAuth.message(o.method.toUpperCase(), path, o.kid, ts, nonce, b64);
		const sig = crypto.createHmac("sha256", Buffer.from(o.key, "hex")).update(message).digest("hex");
		return { authorization: `PayAuth v=1, ts=${ts}, nonce=${nonce}, kid=${o.kid}, alg=hmac-sha256, sig=${sig}`, b64 };
	}
}
