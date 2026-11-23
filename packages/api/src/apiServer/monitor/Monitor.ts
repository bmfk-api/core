import { Signal } from "../../signal/Signal";
import { APIServiceOptions, REQ_HTTP_LOG, REQ_MONITOR_USERS, REQ_MONITOR_ALLOWED_IPS } from "../APIService";
import { IpAllowList } from "../helper/IpAllowList";
import { BaseEndpoint } from "../BaseEndpoint";
import { BaseService } from "../BaseService";
import { logError, logInfo, logWarn, REQ_CURRENT_LOG_LEVEL, REQ_LOG, REQ_LOG_UNIQUE_SERVICES, S_LOG_CHANGE_LEVEL } from "../LogService";
import { IRequest, IResponse } from "../structures/Interfaces";
import crypto from "crypto";
import DefaultErrors from "../structures/DefaultErrors";
import fs from "fs";
import path from "path";
import { Http } from "../http/Http";
import { REQ_STAT, REQ_STAT_WEEKS, REQ_STAT_WEEK } from "../MonitorService";
import { DBService } from "../DBService";
import { collectSystemInfo } from "./SystemInfo";
import { ProcessMonitor } from "./ProcessMonitor";
import { listLogSources, tailLog, LOG_SOURCES, TLogSourceId } from "./LogFiles";
import { MonitorAuth, TMonitorCapability } from "./MonitorAuth";
import { ThreatMonitor } from "./ThreatMonitor";
import { BlockedIps } from "../security/BlockedIps";


export interface IUserAction{
    action:string;
}

export const S_MONITOR_REGISTRATE_ACTION=new Signal<IUserAction>()

// Fired when an authenticated operator requests a restart via the monitor. The app can listen to
// gracefully flush state before the process exits (there is a short grace window before exit).
export interface IRestartRequest{ by:string; name:string|null; pmId:string|null; }
export const S_MONITOR_RESTART_REQUESTED=new Signal<IRestartRequest>()

const logMap:Record<string,number>={
    ALL:10,
    API:19,
    INFO:20,
    DB:25,
    WARN:30,
    ERROR:40,
    CRIT:50,
}

export class Monitor extends BaseEndpoint{

    ignoreHttpLogging=true
    ignoreInDocumentation=true;
    indexHtmlFile:string | null = null;
    apiServiceOptions:APIServiceOptions;
    fileParsed:boolean=false;

    lastTimeCacheChecked:number=0;
    
    constructor(options:APIServiceOptions){
        super("sm");
        this.apiServiceOptions=options
        MonitorAuth.configure({ authFile: options.monitorAuthFile, authDir: options.monitorAuthDir, projectName: options.projectName });
        this.registerEndpoints([
            {ignoreInterceptor:true,endpoint:"html",handler:this.html},
            {ignoreInterceptor:true,endpoint:"log",handler:this.logs},
            {ignoreInterceptor:true,endpoint:"netlog",handler:this.netlog},
            {ignoreInterceptor:true,endpoint:"outgoingnetlog",handler:this.outgoingNetlog},
            {ignoreInterceptor:true,endpoint:"sysinfo",handler:this.sysinfo},
            {ignoreInterceptor:true,endpoint:"procinfo",handler:this.procinfo},
            {ignoreInterceptor:true,endpoint:"fdreport",handler:this.fdreport},
            {ignoreInterceptor:true,endpoint:"login",handler:this.login,validationModel:{
                login:"",
                password:"",
                totp:"",
                $__totp_optional:true
            }},
            {ignoreInterceptor:true,endpoint:"enroll2fa",handler:this.enroll2fa,validationModel:{
                enrollmentToken:"",
                totp:""
            }},
            {ignoreInterceptor:true,endpoint:"logout",handler:this.logout},
            {ignoreInterceptor:true,endpoint:"restart",handler:this.restart,validationModel:{
                confirm:"",
                password:"",
                totp:"",
                $__totp_optional:true
            }},
            {ignoreInterceptor:true,endpoint:"inventory",handler:this.inventory},
            {ignoreInterceptor:true,endpoint:"httpstats",handler:this.httpstats},
            {ignoreInterceptor:true,endpoint:"metrics",handler:this.metrics,validationModel:{
                range:"",
                $__range_values:["week","day","hour"]
            }},
            {ignoreInterceptor:true,endpoint:"threats",handler:this.threats,validationModel:{
                limit:0,
                $__limit_optional:true
            }},
            {ignoreInterceptor:true,endpoint:"logfiles",handler:this.logfiles},
            {ignoreInterceptor:true,endpoint:"logtail",handler:this.logtail,validationModel:{
                source:"",
                $__source_values:[...LOG_SOURCES],
                lines:0,
                $__lines_optional:true,
                since:0,
                $__since_optional:true,
                filter:"",
                $__filter_optional:true
            }},
            {ignoreInterceptor:true,endpoint:"metricsWeeks",handler:this.metricsWeeks},
            {ignoreInterceptor:true,endpoint:"metricsWeek",handler:this.metricsWeek,validationModel:{
                weekKey:""
            }},
            
            {ignoreInterceptor:true,endpoint:"connections",handler:this.connections},
            {ignoreInterceptor:true,endpoint:"db",handler:this.db,validationModel:{
                range:"",
                $__range_values:["week","day","hour"]
            }},
            {ignoreInterceptor:true,endpoint:"blocked",handler:this.blocked},
            {ignoreInterceptor:true,endpoint:"block",handler:this.block,validationModel:{
                ip:"", reason:"", $__reason_optional:true, hours:0, $__hours_optional:true
            }},
            {ignoreInterceptor:true,endpoint:"unblock",handler:this.unblock,validationModel:{ ip:"" }},
            {ignoreInterceptor:true,endpoint:"controllers",handler:this.controllers},
            {ignoreInterceptor:true,endpoint:"changeLogLevel",handler:this.changeLogLevel,validationModel:{
                level:Object.keys(logMap).join(",")
            }}
        ])
    }

    // Runs before every sm/* handler (the page, sign-in and every session call), so a session
    // token taken elsewhere is useless outside the allowed addresses too.
    override async __precheck(req:IRequest):Promise<IResponse<any>|null>{
        const entries = await REQ_MONITOR_ALLOWED_IPS.request();
        if(!entries || entries.length === 0) return null;
        const { list, error } = IpAllowList.build(entries);
        if(error){
            // Only an inline option can get here (a bad access file is never applied): a typo must
            // close the monitor, not open it.
            logError(`Monitor: monitorAllowedIps is invalid (${error}) — the monitor refuses every request until it is fixed`);
            return { error: { ...DefaultErrors.FORBIDDEN } };
        }
        if(!IpAllowList.allows(list, req.ip)){
            logWarn(`Monitor: request refused from ${req.ip ?? "unknown"} — not in monitorAllowedIps`);
            return { error: { ...DefaultErrors.FORBIDDEN } };
        }
        return null;
    }

    async loadHTMLFile(){
        if(!this.indexHtmlFile)
            this.indexHtmlFile = fs.readFileSync(path.resolve(__dirname,"index.html")).toString("utf-8");
        return this.indexHtmlFile;
    }


    async html(req:IRequest):Promise<IResponse>{
        
        this.indexHtmlFile = await this.loadHTMLFile();

        if(!this.fileParsed){
            this.fileParsed=true;
            let bend = this.apiServiceOptions.baseEndPoint;
            if(!bend.endsWith("/"))
                bend+="/";
            let end = this.endpoint;
            if(!end.endsWith("/"))
                end+="/";
            if(end.startsWith("/"))
                end=end.substring(1);
            const endpoint = bend+end;
            this.indexHtmlFile = this.indexHtmlFile.replace(/{{host}}/g,endpoint);

            let projectName = this.apiServiceOptions.projectName
            if(!projectName)
                projectName = "API Server"
            projectName+=" - Monitoring"
            if(this.apiServiceOptions.appVersion)
                projectName+=" (v.:"+this.apiServiceOptions.appVersion+")"
            this.indexHtmlFile = this.indexHtmlFile.replace(/{{title}}/g,projectName);
        }
    
        // serve index.html file
        return {
            rawResponse:true,
            data:this.indexHtmlFile,
            headers:{
                "Content-Type":"text/html",
                "Content-Length":Buffer.byteLength(this.indexHtmlFile).toString()
            }
        }
    }

    async controllers(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {}
    }

    async changeLogLevel(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"admin");

        const val = logMap[req.data.level];
        if(!val)
            throw {...DefaultErrors.BAD_REQUEST,details:"bad log level"}

        S_LOG_CHANGE_LEVEL.invoke(req.data.level);
        return {data:(await REQ_CURRENT_LOG_LEVEL.request())}
    }

    async logs(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"logs");
        const services = await REQ_LOG_UNIQUE_SERVICES.request();
        const log = await REQ_LOG.request({
            lastID:req.data.lastID ?? 0
        });
        return {
            data:{
                services,
                log
            }
        }
    }

    async netlog(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"logs");
        const log = await REQ_HTTP_LOG.request(req.data);
        return {data:log}
    }

    async outgoingNetlog(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"logs");
        return {data:Http.getOutgoingLogSnapshot()}
    }

    async sysinfo(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data: await collectSystemInfo()}
    }

    async procinfo(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data: await ProcessMonitor.getSnapshot()}
    }

    async fdreport(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data: await ProcessMonitor.getFdReport()}
    }

    // Exchange credentials for a short-lived session token. Unauthenticated by design — this IS
    // the authentication. Brute force is bounded by MonitorAuth's lockout.
    async login(req:IRequest):Promise<IResponse>{
        const users = await REQ_MONITOR_USERS.request();
        if(!users || users.length===0){
            logWarn("Monitor: sign-in refused — no monitor users are configured (access.monitor)");
            throw {...DefaultErrors.UNAUTHORIZED}
        }

        const { user, error, enrollmentRequired } = await MonitorAuth.authenticate(users, req.data.login, req.data.password, req.data.totp);
        if(!user || error){
            logWarn(`Monitor login failed for "${req.data.login}" from ${req.ip ?? "unknown"}: ${error}`);
            throw {...DefaultErrors.UNAUTHORIZED,details:error ?? "Invalid user"}
        }

        // Password is right but no second factor is set up yet: hand back everything needed to
        // scan a QR. This is NOT a session — nothing in sm/* is reachable until enrollment ends.
        if(enrollmentRequired){
            const issuer = this.apiServiceOptions.projectName || "Monitor";
            const { token, secret, uri } = MonitorAuth.beginEnrollment(user.login, issuer);
            logInfo(`Monitor 2FA enrollment started for "${user.login}"`,"Monitor");
            return {data:{
                enrollmentRequired: true,
                enrollmentToken: token,
                secret,                 // for manual entry when a camera is not available
                otpauthUri: uri,        // render this as a QR code
                expiresInMs: MonitorAuth.ENROLLMENT_TTL_MS,
            }}
        }

        const session = MonitorAuth.createSession(user.login);
        logInfo(`Monitor login: "${user.login}" from ${req.ip ?? "unknown"}`,"Monitor");
        return {data:{
            token: session.token,
            login: user.login,
            idleTimeoutMs: MonitorAuth.SESSION_IDLE_MS,
            maxLifetimeMs: MonitorAuth.SESSION_MAX_MS,
            twoFactor: true,
            ...MonitorAuth.describeRole(user.role),
        }}
    }

    // Finish enrollment: the code proves the authenticator holds the secret, so we persist it and
    // start a normal session straight away.
    async enroll2fa(req:IRequest):Promise<IResponse>{
        const { login, error } = MonitorAuth.completeEnrollment(req.data.enrollmentToken, req.data.totp);
        if(!login || error || login.includes(":")){   // "doc:<login>" is a documentation enrollment
            logWarn(`Monitor 2FA enrollment failed: ${error}`);
            throw {...DefaultErrors.UNAUTHORIZED,details:error ?? "Enrollment failed"}
        }
        // Same shape as sm/login — including role and capabilities. Without them the client would
        // have to assume the least-privileged role until the next login and would hide sections an
        // admin is entitled to (the server enforces access either way, so this is a UI concern).
        const users = await REQ_MONITOR_USERS.request();
        const user = users?.find(u=>u?.login===login);

        const session = MonitorAuth.createSession(login);
        return {data:{
            token: session.token,
            login,
            idleTimeoutMs: MonitorAuth.SESSION_IDLE_MS,
            maxLifetimeMs: MonitorAuth.SESSION_MAX_MS,
            twoFactor: true,
            ...MonitorAuth.describeRole(user?.role),
        }}
    }

    async logout(req:IRequest):Promise<IResponse>{
        const token = (req.headers['authorization'] ?? "").split(" ").pop() ?? "";
        MonitorAuth.revokeSession(token);
        return {data:{ok:true}}
    }

    async restart(req:IRequest):Promise<IResponse>{
        const login = await this.requireAccess(req,"admin");

        // Step-up: a live session is not enough to restart production — credentials are re-entered
        // for this one action, so a walked-away-from browser cannot be used to bounce the service.
        const users = await REQ_MONITOR_USERS.request();
        const stepUp = await MonitorAuth.authenticate(users ?? [], login, req.data.password, req.data.totp);
        if(!stepUp.user){
            logWarn(`Monitor restart re-auth failed for "${login}": ${stepUp.error}`);
            throw {...DefaultErrors.UNAUTHORIZED,details:"Re-authentication required: "+(stepUp.error ?? "invalid credentials")}
        }


        const id = ProcessMonitor.getPm2Identity();

        // Safety 1 — never exit an unsupervised process: nothing would respawn it, that's an outage.
        if(!id.managed)
            throw {...DefaultErrors.BAD_REQUEST,details:"Process is not managed by pm2 (no pm_id in env) — refusing to exit, nothing would restart it."}

        // Safety 2 — require explicit confirmation matching the real pm2 name, so a stray request
        // (or a mis-click) can't kill production. Client must send { confirm: "<name>" }.
        if(req.data.confirm !== id.name)
            throw {...DefaultErrors.BAD_REQUEST,details:`Confirmation mismatch. To restart send { "confirm": "${id.name}" }.`}

        // Let the app clean up gracefully, and record who did it (audit).
        S_MONITOR_RESTART_REQUESTED.invoke({by:login,name:id.name,pmId:id.pmId})
        S_MONITOR_REGISTRATE_ACTION.invoke({action:`restart requested by "${login}" for pm2 "${id.name}" (id ${id.pmId})`})
        logInfo(`Restart requested via monitor by "${login}" for pm2 process "${id.name}" (id ${id.pmId})`,"Monitor")

        // Safety 3 — respond FIRST, exit AFTER a grace window so the HTTP response reaches the
        // client and listeners get a chance to flush. pm2 autorestart then respawns us.
        const graceMs = 750;
        setTimeout(()=>{
            logInfo(`Exiting now for pm2 restart (requested by "${login}")`,"Monitor")
            process.exit(0)
        },graceMs)

        return {data:{restarting:true,name:id.name,pmId:id.pmId,by:login,graceMs}}
    }

    async httpstats(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data: Http.getHttpStats()}
    }

    async inventory(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");

        const now = Date.now();

        const services = BaseService.allInstances.map(s => ({
            className: s.constructor.name,
            name: s.getName(),
            initialized: s.initializedAt !== null,
            createdAt: s.createdAt,
            initializedAt: s.initializedAt,
            applicationReadyAt: s.applicationReadyAt,
            uptimeSec: s.initializedAt ? Math.round((now - s.initializedAt) / 1000) : null,
        }));

        const endpoints = BaseEndpoint.allInstances.map(e => e.getInventory());

        return {
            data: {
                services,
                endpoints,
                counts: {
                    services: services.length,
                    endpoints: endpoints.length,
                    totalHandlers: endpoints.reduce((sum, e) => sum + e.handlerCount, 0),
                },
                entrypoint: BaseEndpoint.getEntryPoint(),
            }
        };
    }

    async metrics(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        const result = await REQ_STAT.request(req.data);
        return {data:result}
    }

    // Probe/scan detection results. Contains client IPs, hence the logs capability.
    async threats(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"logs");
        const limit = Number(req.data.limit) || 50;
        const snap = ThreatMonitor.snapshot(limit);
        // Lets the page show "blocked" next to an offender instead of a block button.
        return {data: { ...snap, offenders: snap.offenders.map(o => ({ ...o, blocked: BlockedIps.isBlocked(o.ip) })) }}
    }

    async blocked(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"logs");
        return {data: BlockedIps.snapshot()}
    }

    // Manual ban from the threats page. Refuses to lock out the admin doing it.
    async block(req:IRequest):Promise<IResponse>{
        const login = await this.requireAccess(req,"admin");
        const ip = String(req.data.ip ?? "").trim();
        const built = IpAllowList.build([ip]);
        if(!ip || built.error)
            throw {...DefaultErrors.BAD_REQUEST, details: built.error ?? "ip is required"}
        if(IpAllowList.allows(built.list, "127.0.0.1") || IpAllowList.allows(built.list, "::1"))
            throw {...DefaultErrors.BAD_REQUEST, details:"Loopback can't be blocked"}
        if(req.ip && IpAllowList.allows(built.list, req.ip))
            throw {...DefaultErrors.BAD_REQUEST, details:`This would block your own address (${req.ip})`}
        const hours = Number(req.data.hours) || 0;
        if(hours < 0 || hours > 24 * 365)
            throw {...DefaultErrors.BAD_REQUEST, details:"hours must be between 0 (permanent) and 8760"}
        const entry = {
            ip,
            ...(req.data.reason ? { reason: String(req.data.reason).slice(0, 200) } : {}),
            until: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
            by: login,
            at: new Date().toISOString(),
        };
        try{ BlockedIps.add(entry); }
        catch(e:any){ throw {...DefaultErrors.INTERNAL_SERVER_ERROR, details: e?.message ?? String(e)} }
        logWarn(`Monitor: "${login}" blocked ${ip}${hours ? ` for ${hours} h` : " permanently"}${entry.reason ? ` — ${entry.reason}` : ""}`);
        return {data: BlockedIps.snapshot()}
    }

    async unblock(req:IRequest):Promise<IResponse>{
        const login = await this.requireAccess(req,"admin");
        const ip = String(req.data.ip ?? "").trim();
        let removed: boolean;
        try{ removed = BlockedIps.remove(ip); }
        catch(e:any){ throw {...DefaultErrors.INTERNAL_SERVER_ERROR, details: e?.message ?? String(e)} }
        if(!removed) throw {...DefaultErrors.NOT_FOUND, details:`${ip} is not in the list`}
        logWarn(`Monitor: "${login}" unblocked ${ip}`);
        return {data: BlockedIps.snapshot()}
    }

    async logfiles(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"logs");
        return {data: await listLogSources(this.apiServiceOptions.logFiles)}
    }

    async logtail(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"logs");
        const num = (v:any) => (v === undefined || v === null || v === "" ? undefined : Number(v));
        try{
            return {data: await tailLog(req.data.source as TLogSourceId, this.apiServiceOptions.logFiles, {
                lines: num(req.data.lines),
                since: num(req.data.since),
                filter: req.data.filter,
            })}
        }catch(e:any){
            const details = e?.code === "ENOENT" ? "log file not found"
                          : e?.code === "EACCES" ? "permission denied: the node process user can't read this file (nginx logs are usually root:adm 0640 — add the user to the adm group or point access_log to a readable file)"
                          : String(e?.message ?? e);
            throw {...DefaultErrors.BAD_REQUEST, details}
        }
    }

    async metricsWeeks(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data: await REQ_STAT_WEEKS.request()}
    }

    async metricsWeek(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data: await REQ_STAT_WEEK.request({weekKey:req.data.weekKey})}
    }

    async connections(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data:Http.getActiveConnectionsSnapshot()}
    }

    async db(req:IRequest):Promise<IResponse>{
        await this.requireAccess(req,"dashboard");
        return {data:DBService.healthcheck(req.data.range)}
    }

   

   // Authenticate, then check the account's role against what this endpoint needs.
    // Returns the login so handlers can keep using it for audit messages.
    async requireAccess(req:IRequest, capability:TMonitorCapability):Promise<string>{
        const login = await this.checkAuthentication(req);
        const users = await REQ_MONITOR_USERS.request();
        const user = users?.find(u=>u?.login===login);
        // A session can outlive its user (access is reloaded live). Without this an unknown
        // user would fall through to the "no role → admin" default.
        if(!user){
            MonitorAuth.revokeAllFor(login);
            throw {...DefaultErrors.UNAUTHORIZED,details:"User no longer has monitor access"}
        }
        if(!MonitorAuth.roleAllows(user.role, capability)){
            const { role } = MonitorAuth.describeRole(user?.role);
            logWarn(`Monitor access denied: "${login}" (role ${role}) tried a "${capability}" endpoint`);
            throw {...DefaultErrors.FORBIDDEN,details:`Role "${role}" is not allowed to access ${capability} endpoints`}
        }
        return login;
    }

   async checkAuthentication(req:IRequest):Promise<string>{
        const users = await REQ_MONITOR_USERS.request();

        if(!users || users.length==0)
            throw {...DefaultErrors.UNAUTHORIZED}

        const header = req.headers['authorization'];
        if(!header)
            throw {...DefaultErrors.UNAUTHORIZED,details:"No authorization header found"}

        const token = header.split(" ").pop() ?? "";
        if(!token || token.length<32)
            throw {...DefaultErrors.UNAUTHORIZED,details:"Wrong authorization header"}

        // Sessions only. The old static sha256(login:password) bearer is gone: it was a password
        // equivalent that never expired and could not carry a second factor.
        const session = MonitorAuth.touchSession(token);
        if(!session)
            throw {...DefaultErrors.UNAUTHORIZED,details:"Session is invalid or expired"}

        return session.login;
    }
    
}
