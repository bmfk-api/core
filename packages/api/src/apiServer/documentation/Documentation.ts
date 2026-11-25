import { logInfo, logWarn } from "../LogService";
import { APIServiceOptions, REQ_DOC_USERS, IDocumentationUser } from "../APIService";
import { BaseEndpoint } from "../BaseEndpoint";
import { REQ_DOC } from "../DocumentService";
import DefaultErrors from "../structures/DefaultErrors";
import { IRequest, IResponse } from "../structures/Interfaces";
import { MonitorAuth } from "../monitor/MonitorAuth";
import fs from "fs";
import path from "path";

// Documentation users sign in the way monitor users do — password stored as a hash, a second factor
// enrolled at the first sign-in, sessions that end after 15 min idle and 8 h at most, lockout after 10
// failed attempts — through MonitorAuth, in their own realm: sessions, failures and 2FA records are
// kept under "doc:<login>", so a documentation session never opens the monitor and the other way round.
// MonitorAuth is configured by the Monitor endpoint, which APIService always mounts next to this one.
const REALM = "doc:";

export class Documentation extends BaseEndpoint{

    indexHtmlFile:string | null = null;
    apiServiceOptions:APIServiceOptions;

    constructor(options:APIServiceOptions){
        super("doc")
        this.apiServiceOptions = options;
        this.ignoreInDocumentation=true;
        this.ignoreHttpLogging=true
        this.registerEndpoints([
            { ignoreInDocumentation:true, endpoint:"html", handler:this.html, ignoreInterceptor:true },
            { ignoreInDocumentation:true, endpoint:"json", handler:this.json, ignoreInterceptor:true },
            { ignoreInDocumentation:true, endpoint:"login", handler:this.login, ignoreInterceptor:true,
              validationModel:{ login:"", password:"", totp:"", $__totp_optional:true } },
            { ignoreInDocumentation:true, endpoint:"enroll2fa", handler:this.enroll2fa, ignoreInterceptor:true,
              validationModel:{ enrollmentToken:"", totp:"" } },
            { ignoreInDocumentation:true, endpoint:"logout", handler:this.logout, ignoreInterceptor:true },
        ])
    }

    private static users(list: IDocumentationUser[] | undefined): IDocumentationUser[] {
        return (list ?? []).map(u => ({ ...u, login: REALM + u.login }));
    }

    private session(login: string) {
        const s = MonitorAuth.createSession(REALM + login);
        return { token: s.token, login, idleTimeoutMs: MonitorAuth.SESSION_IDLE_MS, maxLifetimeMs: MonitorAuth.SESSION_MAX_MS, twoFactor: true };
    }

    // Unauthenticated by design — this IS the authentication; brute force is bounded by the lockout.
    async login(req:IRequest):Promise<IResponse>{
        const users = await REQ_DOC_USERS.request();
        if(!users || users.length===0){
            logWarn("Documentation: sign-in refused — no documentation users are configured (access.documentation)");
            throw {...DefaultErrors.UNAUTHORIZED}
        }
        const login = String(req.data.login);
        const { user, error, enrollmentRequired } = await MonitorAuth.authenticate(Documentation.users(users), REALM + login, req.data.password, req.data.totp);
        if(!user || error){
            logWarn(`Documentation login failed for "${login}" from ${req.ip ?? "unknown"}: ${error}`);
            throw {...DefaultErrors.UNAUTHORIZED,details:error ?? "Invalid user"}
        }
        if(enrollmentRequired){
            const issuer = (this.apiServiceOptions.projectName || "API") + " documentation";
            const { token, secret, uri } = MonitorAuth.beginEnrollment(REALM + login, issuer, login);
            logInfo(`Documentation 2FA enrollment started for "${login}"`);
            return {data:{ enrollmentRequired:true, enrollmentToken:token, secret, otpauthUri:uri, expiresInMs:MonitorAuth.ENROLLMENT_TTL_MS }}
        }
        logInfo(`Documentation login: "${login}" from ${req.ip ?? "unknown"}`);
        return {data:this.session(login)}
    }

    async enroll2fa(req:IRequest):Promise<IResponse>{
        const { login, error } = MonitorAuth.completeEnrollment(req.data.enrollmentToken, req.data.totp);
        if(!login || error || !login.startsWith(REALM)){
            logWarn(`Documentation 2FA enrollment failed: ${error ?? "not a documentation enrollment"}`);
            throw {...DefaultErrors.UNAUTHORIZED,details:error ?? "Enrollment failed"}
        }
        return {data:this.session(login.slice(REALM.length))}
    }

    async logout(req:IRequest):Promise<IResponse>{
        const token = (req.headers['authorization'] ?? "").split(" ").pop() ?? "";
        const s = MonitorAuth.touchSession(token);
        if(s?.login.startsWith(REALM)) MonitorAuth.revokeSession(token);
        return {data:{ok:true}}
    }

    /** The signed-in documentation user (from `Authorization: Bearer <session token>`). */
    private async requireUser(req:IRequest):Promise<IDocumentationUser>{
        const token = (req.headers['authorization'] ?? "").split(" ").pop() ?? "";
        const s = token ? MonitorAuth.touchSession(token) : null;
        if(!s || !s.login.startsWith(REALM))
            throw {...DefaultErrors.UNAUTHORIZED,details:"Sign in again"}
        const login = s.login.slice(REALM.length);
        const user = (await REQ_DOC_USERS.request())?.find(u => u?.login === login);
        // Access is reloaded live: a removed user loses the session at once.
        if(!user){
            MonitorAuth.revokeAllFor(s.login);
            throw {...DefaultErrors.UNAUTHORIZED,details:"User no longer has documentation access"}
        }
        return user;
    }

    async json(req:IRequest){
        const endpoints = (await this.requireUser(req)).endpoints;
        let doc = JSON.parse(JSON.stringify(await REQ_DOC.request())) as Record<string, any>[];

        if (endpoints && endpoints.length > 0) {
            // Only the endpoints this user may see: "group/name" exactly, or "group/*" for a whole branch.
            doc = doc.filter((group: any) => {
                if (group.endpoints && Array.isArray(group.endpoints)) {
                    group.endpoints = group.endpoints.filter((ep: any) => {
                        const name = ep.name;
                        return endpoints.some((pattern: string) => {
                            if (pattern.endsWith('/*')) {
                                const base = pattern.slice(0, -2);
                                return name === base || name.startsWith(base + '/');
                            }
                            return name === pattern;
                        });
                    });
                }
                return group.endpoints && group.endpoints.length > 0;
            });
        }

        return {data:doc};
    }

    async html(req:IRequest):Promise<IResponse<any>>{
        if(!this.indexHtmlFile){
            this.indexHtmlFile = fs.readFileSync(path.resolve(__dirname,"index.html")).toString("utf-8");
            let bend = this.apiServiceOptions.baseEndPoint;
            if(!bend.endsWith("/"))
                bend+="/";
            let end = this.endpoint;
            if(!end.endsWith("/"))
                end+="/";
            if(end.startsWith("/"))
                end=end.substring(1);
            const endpoint = bend+end+"json";
            this.indexHtmlFile = this.indexHtmlFile.replace(/{{host}}/g,endpoint);

            let projectName = this.apiServiceOptions.projectName
            if(!projectName)
                projectName = "API Server"
            projectName+=" - Documentation"
            if(this.apiServiceOptions.appVersion)
                projectName+=" (v.:"+this.apiServiceOptions.appVersion+")"
            this.indexHtmlFile = this.indexHtmlFile.replace(/{{title}}/g,projectName);
        }

        return {
            rawResponse:true,
            data:this.indexHtmlFile,
            headers:{
                "Content-Type":"text/html",
                "Content-Length":Buffer.byteLength(this.indexHtmlFile).toString(),
                // The page signs in with password + TOTP: it may talk to its own origin only.
                "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            }
        }
    }
}
