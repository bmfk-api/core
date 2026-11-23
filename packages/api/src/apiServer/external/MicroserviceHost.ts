import { Req } from "../../signal/Signal";
import { BaseService } from "../BaseService";
import { IRequest, IError } from "../structures/Interfaces";
import DefaultErrors, { ErrorUtils } from "../structures/DefaultErrors";
import { InterceptorSignedAuth } from "../interceptors/InterceptorSignedAuth";
import { JSONStableStringify } from "../helper/JSONStableStringify";
import { logError, logWarn } from "../LogService";
import { AsyncLocalStorage } from "async_hooks";
import { Trace } from "../helper/Trace";
import crypto from "crypto";
import net from "net";
import { IpAllowList } from "../helper/IpAllowList";

// Signed calls: every caller has its own Ed25519 key pair, like deployer users. The caller
// signs each request (InterceptorSignedAuth: path, ts, nonce, body), the host signs each answer
// with its own key, bound to that request's nonce. Nothing on either side is a shared secret.
// Confidentiality is TLS: the client refuses plain http to anything but localhost.
//
// Request body:  { v: 1, to: <host id>, op: <operation id>, trace?: <caller's trace id>, requestName, requestData }
// Answer (data): { v: 1, op, result? | error? | pending?, sig }
//
// `op` is chosen by the caller once per operation and kept across retries: the host runs an op once
// and answers retries from its job store. The store is the host's memory unless one is passed, so a
// restart (a deploy) forgets it — a handler that moves money must also check `op` in its own
// database, in the same transaction as the effect (MicroserviceHost.currentCall()).

export interface IMicroserviceCaller {
    publicKey: string;        // the caller's Ed25519 public key, base64 SPKI (`bmfk ms-key`)
    requests?: string[];      // names it may call; all of `requests` when omitted
    // Addresses it may call from: IPs and CIDR subnets, IPv4/IPv6. Any address when omitted. The
    // address is the real client's — X-Real-IP / X-Forwarded-For only from options.trustedProxies
    // (nginx), the TCP peer otherwise — so a leaked key is useless from anywhere else.
    allowedIps?: string[];
}

export interface IMicroserviceHostOptions {
    id: string;                                     // service id
    requests: Req<any, any>[];                      // registered requests
    privateKey: string;                             // this host's Ed25519 private key — signs the answers
    clients: Record<string, IMicroserviceCaller>;   // allowed callers by key id
    jobStore?: IMicroserviceJobStore;               // where finished ops are kept; memory when omitted
}

export interface IMicroserviceJob {
    status: "processing" | "completed";
    hash?: string;            // sha256 of the request: an op reused for another request is refused
    result?: any | IError;
    expires: number;          // epoch ms
}

export interface IMicroserviceJobStore {
    get(key: string): Promise<IMicroserviceJob | null> | IMicroserviceJob | null;
    set(key: string, job: IMicroserviceJob): Promise<void> | void;
    purge(now: number): Promise<void> | void;
}

export class MemoryJobStore implements IMicroserviceJobStore {
    #jobs = new Map<string, IMicroserviceJob>();
    get(key: string) { return this.#jobs.get(key) ?? null; }
    set(key: string, job: IMicroserviceJob) { this.#jobs.set(key, job); }
    purge(now: number) { for (const [k, j] of this.#jobs) if (j.expires < now) this.#jobs.delete(k); }
}

export interface IMicroserviceCall { caller: string, op: string, requestName: string }

export const MICROSERVICE_PROTOCOL = 1;
const ANSWER = "bmfk-ms-answer-v1";
const JOB_TTL = 1000 * 60 * 5;

export class MicroserviceHost extends BaseService {

    static #instances:Map<string,MicroserviceHost> = new Map();
    static #context = new AsyncLocalStorage<IMicroserviceCall>();

    options:IMicroserviceHostOptions;
    #store: IMicroserviceJobStore;
    #auth: InterceptorSignedAuth;
    #allowedIps = new Map<string, net.BlockList>();   // by key id; no entry → any address

    constructor(opt:IMicroserviceHostOptions){
        super("Microservice-host-"+opt.id);
        if (!opt.clients)
            throw new Error(`MicroserviceHost "${opt.id}": set "clients" — the callers and their public keys`);
        if (!opt.privateKey)
            throw new Error(`MicroserviceHost "${opt.id}": set "privateKey" — the host signs its answers`);
        InterceptorSignedAuth.publicKeyOf(opt.privateKey);   // throws on a broken key now, not on the first call
        this.#auth = new InterceptorSignedAuth(kid => opt.clients[kid]?.publicKey ?? null);
        // A typo here must stop the host, not silently let every address in.
        for (const [kid, c] of Object.entries(opt.clients)) {
            if (c.allowedIps === undefined) continue;
            const built = IpAllowList.build(c.allowedIps);
            if (built.error) throw new Error(`MicroserviceHost "${opt.id}": clients.${kid}.allowedIps: ${built.error}`);
            if (!built.list) throw new Error(`MicroserviceHost "${opt.id}": clients.${kid}.allowedIps is empty — list the addresses, or remove it to allow any`);
            this.#allowedIps.set(kid, built.list);
        }
        this.options = opt;
        this.#store = opt.jobStore ?? new MemoryJobStore();
        MicroserviceHost.#instances.set(opt.id,this);
    }

    async init():Promise<void>{
        super.init();
        setInterval(()=>{
            Promise.resolve(this.#store.purge(Date.now())).catch(e => logError("MicroserviceHost job store purge failed", e));
        },1000 * 60 * 5) // clear expired jobs every 5 minutes
    }

    static getMicroservice(id:string):MicroserviceHost|null{
        return MicroserviceHost.#instances.get(id) || null;
    }

    /** Inside a request handler run by a host: who called and the operation id (null elsewhere). */
    static currentCall(): IMicroserviceCall | null {
        return MicroserviceHost.#context.getStore() ?? null;
    }

    /** What the host signs for an answer — the client checks the same text. */
    static answerMessage(hostId: string, op: string, nonce: string, answer: { result?: any, error?: any, pending?: boolean }): string {
        const payload = JSONStableStringify(JSON.parse(JSON.stringify({ result: answer.result, error: answer.error, pending: answer.pending })));
        const digest = crypto.createHash("sha256").update(payload).digest("hex");
        return [ANSWER, hostId, op, nonce, digest].join("\n");
    }

    async handleIncomingRequest(req: IRequest): Promise<any | IError> {
        if (String(req.headers?.["authorization"] ?? "").toLowerCase().startsWith("signature "))
            return this.#handleSigned(req);
        return { ...DefaultErrors.UNAUTHORIZED, details: "signed request required" };
    }

    async #handleSigned(req: IRequest): Promise<any | IError> {
        // The address first: a call from the wrong place is refused before any crypto work.
        const claimed = InterceptorSignedAuth.parseHeader(String(req.headers["authorization"]).slice("signature ".length)).kid;
        const ips = claimed ? this.#allowedIps.get(claimed) : undefined;
        if (ips && !IpAllowList.allows(ips, req.ip)) {
            logWarn(`MicroserviceHost ${this.options.id}: rejected call — key "${claimed}" from ${req.ip ?? "unknown address"}, not in its allowedIps`);
            return { ...DefaultErrors.FORBIDDEN, details: "address not allowed" };
        }

        const verdict = await this.#auth.verify(req);
        if (!verdict.kid) {
            logWarn(`MicroserviceHost ${this.options.id}: rejected call — ${verdict.error}`);
            return { ...DefaultErrors.UNAUTHORIZED, details: "invalid signature" };
        }
        const caller = verdict.kid;
        Trace.adopt(req.data?.trace);   // signed by the caller: this call continues the caller's trace
        const nonce = InterceptorSignedAuth.parseHeader(String(req.headers["authorization"]).slice("signature ".length)).nonce;

        const body: any = req.data ?? {};
        if (body.v !== MICROSERVICE_PROTOCOL || body.to !== this.options.id)
            return { ...DefaultErrors.BAD_REQUEST, details: "request is not addressed to this host" };
        if (typeof body.op !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(body.op) || typeof body.requestName !== "string")
            return { ...DefaultErrors.BAD_REQUEST, details: "op and requestName required" };
        const op: string = body.op;
        const requestName: string = body.requestName;
        const answer = (a: { result?: any, error?: any, pending?: boolean }) => this.#signAnswer(op, nonce, a);

        const allowed = this.options.clients[caller]?.requests;
        if (allowed && !allowed.includes(requestName)) {
            logWarn(`MicroserviceHost ${this.options.id}: ${caller} may not call ${requestName}`);
            return answer({ error: { ...DefaultErrors.FORBIDDEN, details: "request not allowed for " + caller } });
        }

        // Jobs are per caller: one caller can't read another's results by guessing an op.
        const jobKey = caller + "|" + op;
        const hash = crypto.createHash("sha256")
            .update(JSONStableStringify(JSON.parse(JSON.stringify({ requestName, requestData: body.requestData ?? null }))))
            .digest("hex");
        const job = await this.#store.get(jobKey);
        if (job && job.expires >= Date.now()) {
            if (job.hash && job.hash !== hash)
                return answer({ error: { ...DefaultErrors.CONFLICT, details: "op was already used for another request" } });
            if (job.status === "processing") return answer({ pending: true });
            return ErrorUtils.isError(job.result) ? answer({ error: job.result }) : answer({ result: job.result });
        }

        const reqCall = this.options.requests.find(r => r.name === requestName);
        if (!reqCall) return answer({ error: { ...DefaultErrors.NOT_FOUND, details: "request not registered: " + requestName } });

        await this.#store.set(jobKey, { status: "processing", hash, expires: Date.now() + JOB_TTL });
        let result: any;
        try {
            result = await MicroserviceHost.#context.run({ caller, op, requestName }, () => reqCall.request(body.requestData));
            if (ErrorUtils.isError(result)) result = MicroserviceHost.#outbound(result);
        } catch (e) {
            if (ErrorUtils.isError(e)) result = MicroserviceHost.#outbound(e);
            else {
                // The cause stays in this host's log; the caller learns only that it failed.
                logError(`MicroserviceHost ${this.options.id}: ${requestName} from ${caller} threw`, e);
                result = { ...DefaultErrors.INTERNAL_ERROR };
            }
        }
        await this.#store.set(jobKey, { status: "completed", hash, result, expires: Date.now() + JOB_TTL });
        return ErrorUtils.isError(result) ? answer({ error: result }) : answer({ result });
    }

    #signAnswer(op: string, nonce: string, a: { result?: any, error?: any, pending?: boolean }) {
        const key = crypto.createPrivateKey({ key: Buffer.from(this.options.privateKey!, "base64"), format: "der", type: "pkcs8" });
        const sig = crypto.sign(null, Buffer.from(MicroserviceHost.answerMessage(this.options.id, op, nonce, a)), key).toString("base64");
        return { v: MICROSERVICE_PROTOCOL, op, ...a, sig };
    }

    // An error leaving the service: no stack (it may hold request data or internals).
    static #outbound(e: IError): IError {
        const { stack, ...rest } = e as any;
        return rest;
    }
}
