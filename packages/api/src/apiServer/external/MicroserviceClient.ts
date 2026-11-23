import { logInfo, logError } from "../LogService";
import { Req } from "../../signal/Signal";
import { BaseService } from "../BaseService";
import { IError } from "../structures/Interfaces";
import DefaultErrors, { ErrorUtils } from "../structures/DefaultErrors";
import { Http } from "../http/Http";
import crypto from "crypto";
import { TimeframeService } from "../TimeframeService";
import { InterceptorSignedAuth } from "../interceptors/InterceptorSignedAuth";
import { MicroserviceHost, MICROSERVICE_PROTOCOL } from "./MicroserviceHost";
import { Trace } from "../helper/Trace";


export interface IMicroserviceClientOptions{
    id:string; // service id (the host's id)
    host:string,
    kid:string;             // this caller's key id, as listed in the host's "clients"
    privateKey:string;      // this caller's Ed25519 private key (`bmfk ms-key`)
    hostPublicKey:string;   // the host's public key — every answer is checked against it
}

export const REQ_MICROSERVICE_CALL = new Req<{
    id:string,
    requestName:string,
    requestData:any,
    // operation id, kept across retries — the host runs it once. Pass a business id (payment,
    // transfer) to make it survive this process too; a random one is used when omitted.
    op?:string,
},any|IError>(undefined,"REQ_MICROSERVICE_CALL")

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class MicroserviceClient extends BaseService {
    static #clients:Map<string,MicroserviceClient> = new Map();
    static #listener:boolean=false;
    static #nextID=1;
    options:IMicroserviceClientOptions;

    constructor(opt:IMicroserviceClientOptions){
        super("MicroserviceClient");
        if (!opt.privateKey || !opt.kid || !opt.hostPublicKey)
            throw new Error(`MicroserviceClient "${opt.id}": set all of "kid", "privateKey" and "hostPublicKey"`);
        InterceptorSignedAuth.publicKeyOf(opt.privateKey);   // throws on a broken key now, not on the first call
        // The signature proves who sent what, not who can read it: that is TLS.
        const url = new URL(opt.host);
        if (url.protocol !== "https:" && !LOOPBACK.has(url.hostname))
            throw new Error(`MicroserviceClient "${opt.id}": ${opt.host} — calls go over https (plain http only to localhost)`);
        this.options=opt;
        MicroserviceClient.#clients.set(opt.id,this);
        if(!MicroserviceClient.#listener){
            REQ_MICROSERVICE_CALL.listener=async (req)=>{
                const client = MicroserviceClient.#clients.get(req.id);
                if(!client){
                    return {...DefaultErrors.BAD_REQUEST,details:"no microservice client found: "+req.id+", requestName:"+req.requestName}
                }
                return await client.requestMicroserviceCall(req);
            }
            MicroserviceClient.#listener=true;
        }
    }
    async init(){
        super.init();
    }

    async requestMicroserviceCall(req: { id: string, requestName: string, requestData: any, op?: string }): Promise<any | IError> {
        return this.#callSigned(req);
    }

    async #callSigned(req: { requestName: string, requestData: any, op?: string }): Promise<any | IError> {
        const url = this.options.host + "/__ms_host_control/receiver";
        const op = req.op ?? crypto.randomUUID();
        // `trace` is signed with the rest: the host takes it over, so one operation has one id across services.
        const body = { v: MICROSERVICE_PROTOCOL, to: this.options.id, op, trace: Trace.current() ?? undefined, requestName: req.requestName, requestData: req.requestData };
        const where = [this.options.host, req.requestName, op];   // for errors: never the request data

        const maxAttempts = 10;
        const attemptTimeout = 1000; // ms

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // A new signature (ts, nonce) every attempt — the same op.
            const nonce = crypto.randomBytes(18).toString("base64url");
            const authorization = InterceptorSignedAuth.sign({
                privateKey: this.options.privateKey, kid: this.options.kid, method: "POST", url, data: body, nonce,
            });
            // Retries are this loop's: Http's own would resend the same signature, and a nonce is good once.
            const resp = await Http.post(url, body, {
                headers: { "Content-Type": "application/json", "x-microservice-id": this.options.id, authorization },
                retry: { enabled: false },
            });

            if (!resp.ok && resp.details?.network) {
                if (attempt < maxAttempts) {
                    logInfo(`Retrying microservice call ${req.requestName} (op ${op})... (attempt ${attempt}/${maxAttempts})`);
                    await TimeframeService.wait(attemptTimeout * attempt);
                    continue;
                }
                return { ...DefaultErrors.EXTERNAL_SERVICE_ERROR, details: "Network connection lost after multiple retries, attempts: " + attempt, stack: where as any };
            }

            // Refused before it was run (signature, address, malformed): unsigned, never retried.
            if (!resp.ok) {
                const remoteError = resp.error?.error;
                logInfo(`Microservice call ${req.requestName} refused by ${this.options.host}: HTTP ${resp.status}`, remoteError?.details ?? resp.details);
                if (ErrorUtils.isError(remoteError)) return remoteError;
                return { ...DefaultErrors.EXTERNAL_SERVICE_ERROR, details: resp.details, stack: where as any };
            }

            const a: any = resp.data?.data;
            if (!a || a.v !== MICROSERVICE_PROTOCOL || a.op !== op || typeof a.sig !== "string")
                return { ...DefaultErrors.EXTERNAL_SERVICE_ERROR, details: "the host did not answer a signed call (is it updated?)", stack: where as any };
            if (!this.#verifyAnswer(op, nonce, a)) {
                logError(`Microservice ${this.options.id}: answer signature does not match — not the expected host, or changed on the way`, where);
                return { ...DefaultErrors.EXTERNAL_SERVICE_ERROR, details: "answer signature does not match", stack: where as any };
            }

            if (a.pending === true) {
                if (attempt < maxAttempts) {
                    await TimeframeService.wait(attemptTimeout * attempt);
                    continue;
                }
                return { ...DefaultErrors.EXTERNAL_SERVICE_ERROR, details: "Microservice processing timeout, attempts: " + attempt, stack: where as any };
            }
            return a.error !== undefined ? a.error : (a.result ?? null);
        }

        return { ...DefaultErrors.EXTERNAL_SERVICE_ERROR, details: "Unknown polling error", stack: where as any };
    }

    #verifyAnswer(op: string, nonce: string, a: any): boolean {
        try {
            const key = crypto.createPublicKey({ key: Buffer.from(this.options.hostPublicKey, "base64"), format: "der", type: "spki" });
            const message = MicroserviceHost.answerMessage(this.options.id, op, nonce, { result: a.result, error: a.error, pending: a.pending });
            return crypto.verify(null, Buffer.from(message), key, Buffer.from(a.sig, "base64"));
        } catch { return false; }
    }
}
