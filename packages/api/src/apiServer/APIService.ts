import express, { Application, Response } from 'express'
import { BaseService, IBaseService } from './BaseService'
import cors from 'cors'
import { IncomingMessage } from 'http'
import { BaseEndpoint, IBaseEndpoint } from './BaseEndpoint'
import DefaultErrors, { ErrorUtils } from './structures/DefaultErrors'
import { IRequest, IError, IResponse } from './structures/Interfaces'
import { Signal, Req } from "../signal/Signal";
import { logCrit, logError, logAPI, logWarn, logInfo, LogService } from './LogService'
import { Monitor } from './monitor/Monitor'

import fileUpload from 'express-fileupload'

import { Liveness } from './routes/Liveness'
import { Readiness } from './routes/Readiness'
import http from 'http'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { StatService } from './StatService'
import { MonitorService, S_STAT_REGISTRATE_REQUEST, S_STAT_REGISTRATE_SERVICE } from './MonitorService'
import { isError } from './db/MysqlAdapter'
import { DocumentGenerator } from './DocumentService'
import { Documentation } from './documentation/Documentation'
import { MicroserviceHostController } from './external/MicroserviceHostController'
import { DeployerService, IDeployerServiceOptions } from './deployment/DeployerService'
import { AppData, appDataPath } from './helper/AppDataPath'
import { getBlueGreenActiveState, getBlueGreenStateSync, startBlueGreenWatcher, onLiveChange, IBlueGreenState, IBlueGreenStateOptions } from './deployment/BlueGreenState'
import { ILogFilesOptions } from './monitor/LogFiles'
import { ThreatMonitor } from './monitor/ThreatMonitor'
import { AccessStore, IAccess } from './monitor/AccessStore'
import { BlockedIps } from './security/BlockedIps'
import { MonitorAuth } from './monitor/MonitorAuth'
import { clientIp, fromTrustedProxy, DEFAULT_TRUSTED_PROXIES } from './helper/ClientIp'
import { Trace, TRACE_HEADER } from './helper/Trace'
import { ControlServer } from './control/ControlServer'
import { addReadinessCheck, ReadinessCheck } from './control/ReadinessChecks'
import { onDrain } from './BaseService'
import { Deployer } from './deployment/Deployer'
import { Review } from './review/Review'
import { WebSocketServer as WsServer } from 'ws'
import { WebSocketServer, WebSocketAuthorizer } from './WebSocketServer'


let nextLogID=0;

export interface IMonitorUser{
	// Optional base32 TOTP secret (RFC 6238). When set, the second factor is required at login.
	totpSecret?:string,
	// admin — everything; it — dashboard + logs; analytic — dashboard only.
	// Absent: no access at all (a warning is logged) — the role must be spelled out.
	role?:"admin"|"it"|"analytic",
	login:string,
	password:string
}

export interface IDocumentationUser extends IMonitorUser {
	endpoints?:string[]
}

export interface IDeployerUser extends IMonitorUser {

}

export interface APIServiceNetworkLogItem{	
	id:number,
	traceId?:string,
	created:number,
	time:number,
	referer?:string,
	request:{[key:string]:any},
	response:{[key:string]:any}
	error?:string|null
}

export interface IInterceptor<T>{
	intercept(req:IRequest<any>,internalCallParams:any):Promise<T|IError>
}

export interface APIServiceOptions<TInterceptor=unknown>{
	port:number,
	// Address to listen on. "127.0.0.1" behind a proxy on the same machine; absent: every interface.
	host?:string,
	baseEndPoint:string // "/api/"
	// Browser origins allowed to call the API, besides the API's own (same-origin, always allowed).
	// Default []: same-origin only. "*" lets any site call it, WITHOUT cookies/credentials.
	corsHostWhiteList:string[],
	projectName:string,
	endpoints:IBaseEndpoint[],
	keepAliveTimeout?: number,
	headersTimeout?: number,
	// On SIGTERM/SIGINT: how long requests in progress may take to finish before the connections are
	// cut and the services stop. Default 10 s — keep it below systemd's stop_timeout (15 s) and pm2's
	// --kill-timeout.
	shutdownTimeoutMs?: number,
	jsonLimit:string // "10mb"
	// Default: true unless NODE_ENV=development.
	isProductionEnvironment:boolean,
	interceptor?:IInterceptor<TInterceptor>,
	postproducer?:(req:IRequest|undefined|null,res:Response,data:IResponse<any>,requestTime:number,endpoint?:string,log?:APIServiceNetworkLogItem|null)=>Promise<IResponse>
	preproducer?:(req:IRequest|undefined|null)=>any
	
	// Inline object, or a path to a JSON file of the same shape: the file is watched and
	// re-read on change, so users can be added or removed without a restart or a redeploy.
	// Default "": the data folder's access.json (~/.bmfk/<project>/access.json); while it doesn't
	// exist the monitor and the documentation are closed.
	access:IAccess|string,

	// WebSocket server sharing the HTTP port: reachable at baseEndPoint + endpoint
	// (e.g. "/api/v1/" + "ws" → wss://host/api/v1/ws). Absent → no WebSocket server.
	websocketServer?:IWebSocketServerOptions

	deployer?:IDeployerServiceOptions|null,

	appVersion?:string
	// Where uploads are kept while a request runs. Default: <data folder>/uploads (mode 0700), not
	// the shared /tmp where other users of the server could read them.
	fileTempDir:string;
	fileLimit:number // b
	// Where the monitor keeps metrics history (JSON/JSONL), so it survives restarts and deploys: the
	// live week per minute, older weeks downsampled to hourly, newest 10 weeks kept. Default:
	// ~/.bmfk/<project>/metrics (see helper/AppDataPath) — shared by both blue-green slots, only the
	// live one writes. false → in memory only.
	metricsDir?:string|false
	// Blue-green: how often (ms) the background watcher asks the deployer whether this slot is live.
	// Feeds APIService.blueGreenState and S_BLUEGREEN_STATE_CHANGED. Default 5000; 0 disables.
	// No-op (stops itself) when the app wasn't deployed as a blue-green slot.
	blueGreenWatchMs?:number
	// On-disk logs the monitor may tail (sm/logfiles, sm/logtail). pm2 out/err are auto-detected
	// from pm2's env; nginx paths must be set explicitly. Read-only, sanitized, tail-window only.
	logFiles?:ILogFilesOptions
	// Where monitor 2FA enrollments are persisted. MUST live OUTSIDE any deploy slot — a
	// blue-green deploy recreates the slot directory and would wipe it, forcing everyone to
	// re-enroll. Unset (both) means in-memory only: enrollments are lost on restart.
	//   monitorAuthDir  — directory; the file is named monitor-2fa.<projectName>.json
	//   monitorAuthFile — exact path; takes precedence over monitorAuthDir
	monitorAuthDir?:string
	monitorAuthFile?:string
	// Probe/scan detection (sm/threats). Monitoring only — it never blocks a request. Default on.
	threatMonitoring?:boolean
	// TCP peers whose X-Real-IP / X-Forwarded-For are believed. Default: loopback (nginx on the
	// same host). Anyone else's proxy headers are ignored, so a client cannot spoof its address.
	trustedProxies?:string[]
	// Addresses refused by the whole service (HTTP and WebSocket) with a 403. The list is a JSON
	// file edited by hand or from the monitor, re-read on change. Default file: blocked-ips.json in
	// the project folder (above the slots for blue-green). false → no blocking at all.
	blockedIps?:false|{ file?:string, message?:string }
}



type InferInterceptor<T> = T extends IInterceptor<infer U> ? U : unknown;


// Фабрика дефолтов, параметризованная по T
function defaultOptions<T>(): APIServiceOptions<T> {
  return {
    port: 8080,
    baseEndPoint: "/api/",
    corsHostWhiteList: [],
    endpoints: [],
    jsonLimit: "10mb",
	projectName:"Application project",
    isProductionEnvironment: process.env.NODE_ENV !== "development",
    interceptor: undefined,
    postproducer: undefined,
    preproducer: undefined,
    access: "",
    appVersion: undefined,
    metricsDir: undefined,
    fileTempDir: "",
    fileLimit: 10_000_000, //10 mb
	keepAliveTimeout: 25 * 1000, // 25 seconds
	headersTimeout: 26 * 1000, // 26 seconds
  };
}


export const getDefaultOptions=<I extends IInterceptor<any> | undefined>(
  overrides?: Omit<Partial<APIServiceOptions<InferInterceptor<NonNullable<I>>>>, "interceptor"> & {
    interceptor?: I;
  }
): APIServiceOptions<InferInterceptor<NonNullable<I>>> =>{
  const base = defaultOptions<InferInterceptor<NonNullable<I>>>();
  return { ...base, ...overrides };
}


export const REQ_HTTP_LOG:Req<void,APIServiceNetworkLogItem[]> = new Req(undefined,"REQ_HTTP_LOG");
export const REQ_HTTP_REQUESTS_COUNT:Req<void,number> = new Req(undefined,"REQ_HTTP_REQUESTS_COUNT");
export const REQ_HTTP_SERVER:Req<void,{express:Application,http:http.Server}> = new Req(undefined,"REQ_HTTP_SERVER");
// The WebSocket server, or null when options.websocketServer is not set.
export interface IWebSocketServerOptions{
	endpoint?: string // default "ws"
	// Largest single message in bytes; a bigger one closes the connection (1009). Default 256 KB.
	maxPayload?: number
	// Messages a connection may send per second; going over closes it (1008). Default 20.
	maxMessagesPerSecond?: number
	// Open connections in total / from one client IP (counting those still authorizing);
	// extra handshakes get 503 / 429.
	maxConnections?: number // default 1000
	maxConnectionsPerIp?: number // default 50
	// The client's FIRST message is its authorization: onAuthorize(connection, message) decides
	// (false/null → closed with 4401; an object is kept as connection.auth). It must be sent and
	// answered within authTimeoutMs, otherwise the socket is closed with 4408.
	// Required, unless public: true says on purpose that every connection is accepted at once.
	onAuthorize?: WebSocketAuthorizer
	public?: boolean
	authTimeoutMs?: number // default 10000
}

export const REQ_WS_SERVER:Req<void,WebSocketServer|null> = new Req(undefined,"REQ_WS_SERVER");
export const REQ_INTERNAL_CALL:Req<IRequest,IError|any> = new Req(undefined,"REQ_INTERNAL_CALL");
export const REQ_MONITOR_USERS:Req<void,IMonitorUser[]> = new Req(undefined,"REQ_MONITOR_USERS");
export const REQ_DOC_USERS:Req<void,IDocumentationUser[]> = new Req(undefined,"REQ_DOC_USERS");
export const REQ_MONITOR_ALLOWED_IPS:Req<void,string[]> = new Req(undefined,"REQ_MONITOR_ALLOWED_IPS");

export const S_APP_STARTED = new Signal<void>("S_APP_STARTED");


const activeServices:String[]=[]

// Read the library's own version from its package.json at module load. Works at runtime because
// `dist/apiServer/APIService.js` → `../../package.json` resolves to the lib root (both in this repo
// and in node_modules of a consumer). Falls back to "unknown" if the file can't be read (e.g. when
// the lib is bundled into a monoblob and the relative path no longer points at a real file).
const PACKAGE_VERSION: string = (() => {
	try {
		return JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
})();

export async function Initializer(services:IBaseService[]){
	// add stat service
	services.push(new StatService());
	
    for (let i of services) { 
		await i.init();
		activeServices.push(i.getName());
		S_STAT_REGISTRATE_SERVICE.invoke(i.getName())
	}

	S_APP_STARTED.invoke();
    for (let i of services) { i.applicationReady() }
}


export class APIService<TInterceptorResult=any,TInternalCallParams=any> extends BaseService {

	// SIGINT/SIGTERM (pm2 restart, deploy): what the threat monitor saw since its last save.
	async finishService() {
		await super.finishService();
		ThreatMonitor.save();
	}

	/**
	 * Blue-green: is the slot this process runs in the live one?
	 * Reads the .bluegreen.json the deployer put next to the app and asks the deployer (loopback).
	 * Cached (10s default), never throws — `isActive` is null and `error` set when it can't tell;
	 * `bluegreen:false` when the app wasn't deployed as a blue-green slot.
	 *   const s = await APIService.getBlueGreenActiveState();
	 *   if (s.isActive === false) { … this is the standby slot … }
	 */
	static getBlueGreenActiveState(opts?: IBlueGreenStateOptions): Promise<IBlueGreenState> {
		return getBlueGreenActiveState(opts);
	}

	/**
	 * Last known blue-green state, synchronous and I/O-free — use this in request hot paths.
	 * Kept fresh by the background watcher (options.blueGreenWatchMs). If the latest check failed,
	 * the previous answer is held and `stale` is true (a deployer blip never flips you to standby).
	 * null until the first check completes.
	 */
	static get blueGreenState(): IBlueGreenState | null {
		return getBlueGreenStateSync();
	}

	/**
	 * Should this process act as the live instance right now? true for any non-blue-green project,
	 * isActive for a blue-green slot, null while still unknown. Sync, no I/O.
	 */
	static get isLive(): boolean | null {
		return getBlueGreenStateSync()?.live ?? null;
	}

	/**
	 * Start/stop singleton work (crons, mailers, queue consumers) on the live instance only — same
	 * code before and after the project goes blue-green. Called immediately if already known, then
	 * on every flip; never with an unknown value. Returns an unsubscribe function.
	 *   APIService.onLiveChange(live => live ? startCrons() : stopCrons());
	 */
	static onLiveChange(cb: (live: boolean, state: IBlueGreenState) => void): () => void {
		return onLiveChange(cb);
	}

	/**
	 * What must work for the app to serve requests. GET /readiness answers 503 while a check fails
	 * (and while the app is stopping); the reasons go to the log and to `bmfk ps show`.
	 *   APIService.addReadinessCheck("db", async () => { await db.query("SELECT 1"); return true; });
	 * A check returns true, or false / a reason / throws. Returns a function that removes it.
	 */
	static addReadinessCheck(name: string, check: ReadinessCheck): () => void {
		return addReadinessCheck(name, check);
	}

	/** true from SIGTERM/SIGINT on: no new requests are taken. */
	static draining = false;
	private inFlight = 0;

	private version = PACKAGE_VERSION
	private options:APIServiceOptions;
	private monitor:MonitorService|null=null;
	private deployer:DeployerService|null=null;
	private started:Date = new Date();
	private requestsCount=0;
	private anyOrigin=false;

	netLog:APIServiceNetworkLogItem[]=[];

	/**
	 * The answer to an exception from a handler. An IError thrown on purpose goes out as it is. Anything
	 * else is a bug or a database failure: in production the client gets only the code and a generic
	 * message (the cause is in the log under the same trace id); in development the cause too.
	 */
	private failure(e: unknown): IResponse {
		if (ErrorUtils.isError(e)) return { error: e as IError };
		const dev = !this.options.isProductionEnvironment;
		if (isError(e)) return { error: { ...DefaultErrors.DB_ERROR, ...(dev ? { details: e.message } : {}) } };
		return { error: { ...DefaultErrors.INTERNAL_SERVER_ERROR, ...(dev ? { details: String(e) } : {}) }, httpStatus: 500 };
	}

	/** Where access lives when `access` is "": ~/.bmfk/<project>/access.json. */
	static defaultAccessFile(): string {
		const dir = AppData.dir("");
		return dir ? path.join(dir, "access.json") : appDataPath("access", ".json");
	}

	static withoutStack(data: IResponse): IResponse {
		if (!data.error || data.error.stack === undefined) return data;
		const { stack, ...error } = data.error;
		return { ...data, error };
	}

	private uploadDir(): string {
		if (this.options.fileTempDir) return this.options.fileTempDir;
		const dir = AppData.dir("uploads");
		if (dir) return dir;
		// No data folder: a private folder of this user under the system temp.
		const fallback = path.join(os.tmpdir(), `bmfk-uploads-${process.getuid?.() ?? "u"}`);
		fs.mkdirSync(fallback, { recursive: true, mode: 0o700 });
		if (process.getuid && fs.statSync(fallback).uid !== process.getuid())
			throw new Error(`Uploads: ${fallback} belongs to another user — set fileTempDir`);
		fs.chmodSync(fallback, 0o700);
		logWarn(`Uploads: no data folder — using ${fallback}`);
		return fallback;
	}

	/**
	 * How a browser Origin is treated: "same" — the API's own page (Origin host equals Host),
	 * "listed" — in corsHostWhiteList, "any" — allowed only by "*", "denied" otherwise.
	 */
	static originVerdict(origin: string, host: string | undefined, listed: Set<string>, any: boolean): "same" | "listed" | "any" | "denied" {
		let o: URL;
		try { o = new URL(origin); } catch { return "denied"; }
		if (host && o.host.toLowerCase() === host.toLowerCase()) return "same";
		if (listed.has(o.origin)) return "listed";
		return any ? "any" : "denied";
	}

	constructor(options:APIServiceOptions) {
		super('HTTP Service')
		this.options=options
		if(!this.options.corsHostWhiteList)
			this.options.corsHostWhiteList=[];
		if(this.options.corsHostWhiteList.find(x=>x==="*"))
			this.anyOrigin=true;

		// normalize cors
		const list: string[] = [];
		for (let h of this.options.corsHostWhiteList) {
			if (h === "*") continue;
			h = h.replace(/\/$/, "");

			if (!/^https?:\/\//i.test(h)) {
				// если без протокола, добавим и http и https
				list.push(`http://${h}`, `https://${h}`);
			} else {
				list.push(h);
			}
		}
		// As browsers send it: scheme://host[:port], default port dropped.
		this.options.corsHostWhiteList = Array.from(new Set(list.map(h => { try { return new URL(h).origin; } catch { return h; } })));


		if(this.options.blockedIps !== false)
			BlockedIps.configure(this.options.blockedIps?.file);

		const accessDefault = this.options.access === "";
		const accessSource = accessDefault ? APIService.defaultAccessFile() : this.options.access;
		const access = new AccessStore(accessSource, (prev, next)=>{
			// Sessions outlive a reload: whoever was removed or got a new password loses them now.
			const now = new Map((next.monitor ?? []).map(u=>[u.login, u.password]));
			for(const u of prev.monitor ?? []){
				if(now.get(u.login) === u.password) continue;
				MonitorAuth.revokeAllFor(u.login);
				logWarn(`Monitor: sessions of "${u.login}" revoked (${now.has(u.login) ? "password changed" : "removed from access"})`);
			}
			const plain = MonitorAuth.plaintextLogins(next.monitor ?? []);
			if(plain.length)
				logError(`Monitor: password stored as plain text for ${plain.map(l=>'"'+l+'"').join(", ")} — these logins are refused; store a hash instead: npx bmfk hash-password`);
			// Documentation users the same way; their sessions live under "doc:<login>".
			const nowDoc = new Map((next.documentation ?? []).map(u=>[u.login, u.password]));
			for(const u of prev.documentation ?? []){
				if(nowDoc.get(u.login) === u.password) continue;
				MonitorAuth.revokeAllFor("doc:" + u.login);
				logWarn(`Documentation: sessions of "${u.login}" revoked (${nowDoc.has(u.login) ? "password changed" : "removed from access"})`);
			}
			const plainDoc = MonitorAuth.plaintextLogins(next.documentation ?? []);
			if(plainDoc.length)
				logError(`Documentation: password stored as plain text for ${plainDoc.map(l=>'"'+l+'"').join(", ")} — these logins are refused; store a hash instead: npx bmfk hash-password`);
		}, accessDefault);
		REQ_MONITOR_USERS.listener = async ()=>access.monitor;
		REQ_DOC_USERS.listener = async ()=>access.documentation;
		REQ_MONITOR_ALLOWED_IPS.listener = async ()=>access.monitorAllowedIps;

		// attach endpoint for monitor
		this.options.endpoints.push(new Monitor(this.options));

		// attach endpoint for documentation
		this.options.endpoints.push(new Documentation(this.options));

		// attach endpoints for microservices
		this.options.endpoints.push(new MicroserviceHostController());


		// Switch to deployer
		if(this.options.deployer && this.options.deployer.projects_path && this.options.deployer.setup_path){
			// Pass our own port/base path so the deployer can build the loopback statusUrl it writes
			// into each blue-green slot's .bluegreen.json.
			this.deployer = new DeployerService({
				...this.options.deployer,
				selfPort: this.options.port,
				selfBaseEndPoint: this.options.baseEndPoint,
			});
			this.deployer.init();
			this.options.endpoints=[
				new Deployer(),
				new Review(this.deployer, this.options),
				new Documentation(this.options),
				new Monitor(this.options),
			]
		}

		
		// create monitor service
		this.monitor=new MonitorService(this.options.metricsDir);
		this.monitor.init();

		// create document generator
		new DocumentGenerator(this.options.endpoints as BaseEndpoint[]);


		// create liveness, readiness
		this.options.endpoints.push(new Liveness(this.started),new Readiness(this.started))
		REQ_HTTP_REQUESTS_COUNT.listener = async () => this.requestsCount;
	}


	override async init(): Promise<void> {

		super.init();

		REQ_HTTP_LOG.listener=async _=>this.netLog;
		
		// internal call
		REQ_INTERNAL_CALL.listener = async (req)=>{
			for(let i of this.options.endpoints){
				if(!i || !i.endpoints)
					continue;
				for(let j of i.endpoints){
					let ep = BaseEndpoint.getEntryPoint()+j.endpoint;
					ep = ep.replaceAll("//","/")
					if(ep === req.endpoint){
						req.internalCall=true;
						const response = await i.__execute(req)
						if(response.error)
							return response.error;
						return response.data;
					}
				}
			}
			return {error:DefaultErrors.UNKNOWN_REQUEST,data:null,httpStatus:404}
		}

		// initialize express
		const app = express()

		// Seen by every response (404s, body-parse errors and normal replies alike) through the
		// final status code. Observation only: the request itself is never affected.
		const trustedProxies = new Set(this.options.trustedProxies ?? DEFAULT_TRUSTED_PROXIES);

		// Requests in progress, for a graceful stop. While stopping, a request on a kept-alive connection
		// gets 503 and the connection is closed: nginx retries it on the other slot or upstream.
		app.use((req,res,next)=>{
			if(APIService.draining){
				res.setHeader("Connection","close");
				res.status(503).json({ error:{ code:503, message:"The service is restarting", httpStatus:503 }, data:null, httpStatus:503 });
				return;
			}
			this.inFlight++;
			let counted=true;
			res.on("close",()=>{ if(counted){ counted=false; this.inFlight--; } });
			next();
		});

		// Before anything can answer: every response, a 403 for a blocked address included, carries the
		// request's trace id, and everything the request causes runs with it (see helper/Trace).
		app.use((req,res,next)=>{
			const incoming = req.get(TRACE_HEADER);
			const traceId = Trace.isValid(incoming) && fromTrustedProxy(req, trustedProxies) ? incoming : Trace.newId();
			res.setHeader("X-Request-Id", traceId);
			Trace.run(traceId, next);
		});

		// First in the chain: a blocked client costs no body parsing, CORS or interceptor work.
		if(this.options.blockedIps !== false){
			const message = this.options.blockedIps?.message || "Access from your address is blocked";
			app.use((req,res,next)=>{
				const ip = clientIp(req, trustedProxies);
				if(!BlockedIps.isBlocked(ip)) return next();
				BlockedIps.noteHit(ip);
				res.status(403).json({ error:{ code:403, message, httpStatus:403 }, data:null, httpStatus:403, version:this.options.appVersion });
			});
		}

		if(this.options.threatMonitoring !== false){
			// <data folder>/<project>/threats.json; beside the code when it can't be created.
			const dataDir = AppData.dir("");
			ThreatMonitor.configure(dataDir ? path.join(dataDir, "threats.json") : appDataPath("threats", ".json"));
			app.use((req,res,next)=>{
				res.on("finish",()=>{
					try{
						ThreatMonitor.observe({
							ip: clientIp(req, trustedProxies),
							method: req.method,
							url: req.originalUrl ?? req.url,
							status: res.statusCode,
							ua: req.get("user-agent") ?? null,
							body: (req as any).body,
							contentLength: Number(req.get("content-length")) || 0,
						});
					}catch{ /* monitoring must never break serving */ }
				});
				next();
			});
		}
		const server = http.createServer(app);
		if(this.options.keepAliveTimeout !== undefined)
			server.keepAliveTimeout = this.options.keepAliveTimeout;
		if(this.options.headersTimeout !== undefined)
			server.headersTimeout = this.options.headersTimeout;

		REQ_HTTP_SERVER.listener = async _=>{return {express:app,http:server}};

		const wss = this.options.websocketServer ? this.attachWebSocketServer(server, trustedProxies) : null;
		REQ_WS_SERVER.listener = async _=>wss;

		if(this.options.isProductionEnvironment)
			app.set("env",'production');

		app.use(express.json({ limit: this.options.jsonLimit ??'10mb' })) // for parsing application/json
		app.use(express.urlencoded({ limit: this.options.jsonLimit ?? '10mb', extended: true })) // for parsing application/x-www-form-urlencoded

		app.use(fileUpload({
			limitHandler: (req, res, next)=>{
				this.sendResponse(req.get("Referer")??"",res,{
					error:DefaultErrors.FILE_TOO_LARGE,
					data:null,
					httpStatus:413,
				},+new Date(),req.path,{
				endpoint: req.path,
				headers: req.headers as unknown as any,
				method: req.method,
				data: req.body,
				params: req.params as {[key:string]:string},
				interceptorResult: null,
				raw: req,
				response: undefined,
				files: undefined
			});
			return;
			},
			limits: { fileSize: this.options.fileLimit },
			useTempFiles: true,
			uriDecodeFileNames: true,
			tempFileDir: this.uploadDir(),
			//safeFileNames: true,
			abortOnLimit:true
		}))

		app.use((err:any,req:any,resp:any,next:any)=>{
			
			if(!err){
				next();
				return
			}
			
			//request start time
			const tme = +new Date();
			

			let responseError=DefaultErrors.UNKNOWN_REQUEST;
			if (typeof err === "object" && err.status === 400 && 'body' in err && err.type === 'entity.parse.failed') {
				responseError = DefaultErrors.JSON_MALFORMED
			}
      

			this.sendResponse(req.get("Referer")??"",resp,{
				error:responseError,
				data:null,
				httpStatus:400
			},tme,"",{
				endpoint: "",
				headers: req.headers as unknown as any,
				method: req.method,
				data: req.body,
				params: req.params as {[key:string]:string},
				interceptorResult: null,
				raw: req,
				response: undefined,
				files: undefined
			})
			return;

		})

		
		// Origins: the API's own (Origin host = Host header) always; listed ones with credentials;
		// with "*" any other one, but without credentials — a foreign page must not ride the
		// user's cookies. Behind nginx the Host must be passed: proxy_set_header Host $host;
		const corsSet = new Set(this.options.corsHostWhiteList);
		app.use(cors((req, callback) => {
			const origin = req.headers.origin;
			if (!origin) return callback(null, { origin: false });       // not a cross-origin browser call
			const verdict = APIService.originVerdict(origin, req.headers.host, corsSet, this.anyOrigin);
			if (verdict === "any") return callback(null, { origin: "*", credentials: false });
			return callback(null, { origin: verdict !== "denied", credentials: true });
		}));

		// The cors package only sets headers; this refuses the request itself.
		app.use((req, res, next) => {
			const origin = req.headers.origin;
			if (!origin) return next();
			if (APIService.originVerdict(origin, req.headers.host, corsSet, this.anyOrigin) !== "denied") return next();
			let shown = String(origin).slice(0, 200);
			try { shown = new URL(String(origin)).origin; } catch { }
			res.status(403).send({
				error: { ...DefaultErrors.FORBIDDEN, details: `Origin not allowed: ${shown}` },
				data: null,
				httpStatus: 403,
				version: this.options.appVersion
			});
		});

		// registrate endpoints
		BaseEndpoint.setEntryPoint(this.options.baseEndPoint)
		
		for(let i of this.options.endpoints){
			await i.init();
			if(!i.endpoints)
				continue;
			for(let j of i.endpoints){
				let ep = BaseEndpoint.getEntryPoint()+j.endpoint;
				ep = ep.replaceAll("//","/")
				

				// incoming request
				app.all(ep,async (req,res)=>{
					
					this.requestsCount++;
					const tme = +new Date();
					
					const execute = async ()=>{

						const body = {...(req.body ?? {})};
						if(req.query && typeof req.query === "object"){
							const keys = Object.keys(req.query);
							for(let k of keys)
								body[k]=req.query[k];
						}

						let httpRequest:IRequest = {
							raw:req as IncomingMessage,
							response:res,
							method:req.method,
							data:body,
							params:req.params as {[key:string]:string},
							headers:req.headers as any,
							endpoint:ep,
							files:req.files ?? null,
							referer:req.get("Referer"),
							ip:clientIp(req, trustedProxies),
							traceId:Trace.current() ?? undefined,
						}

						// Resolve ignoreHttpLogging once per request so all sendResponse paths
						// (including error branches) honor it. Order: endpoint → per-method handler → controller.
						let ignoreHttpLogging = j.ignoreHttpLogging ?? false;
						if(!ignoreHttpLogging && typeof j.handler === "object"){
							const handler = j.handler[httpRequest.method.toUpperCase()];
							if(typeof handler === "object")
								ignoreHttpLogging = handler.ignoreHttpLogging ?? false;
						}
						if(!ignoreHttpLogging)
							ignoreHttpLogging = i.ignoreHttpLogging ?? false;

						const respond = (data: IResponse<any>) => {
							data.ignoreHttpLogging = ignoreHttpLogging || data.ignoreHttpLogging || false;
							return this.sendResponse(req.get("Referer")??"",res,data,tme,ep,httpRequest);
						};

						if(this.options.preproducer && ep!=="--sys-monitor"){
							try{
							const preproducerResult = await this.options.preproducer(httpRequest);
							if(preproducerResult)
								httpRequest.preproducerResult = preproducerResult;
							}catch(e){

								logError(e)
								respond(this.failure(e));
								return;
							}
						}

						let result
						try{

							let ignoreInterceptor = false;
							let allowInterceptorError = false;
							if(j.ignoreInterceptor)
								ignoreInterceptor=true;
							if(j.allowInterceptorError)
								allowInterceptorError=true;

							if(typeof j.handler === "object" ){
								// try to get handler relaying on http method
								const handler = j.handler[httpRequest.method.toUpperCase()];
								if(typeof handler === "object"){
									if(handler.ignoreInterceptor)
										ignoreInterceptor=true;
									if(handler.allowInterceptorError)
										allowInterceptorError=true;
								} 
							}

							// Execute interceptor if exists
							if(!ignoreInterceptor){
								let interceptorResult;
								if(this.options.interceptor){

									//const httpRequestBound = bindRequestToOptions(this.options, httpRequest);

									interceptorResult=await this.options.interceptor.intercept(httpRequest,j.internalCallParams);

									if(ErrorUtils.isError(interceptorResult) && !allowInterceptorError){
										respond(interceptorResult);
										return;
									}

									//httpRequestBound.interceptorResult = interceptorResult
									httpRequest.interceptorResult = interceptorResult
								}
							}

							const precheck=await i.__precheck(httpRequest)
							if(precheck && precheck.error){
								respond(precheck);
								return;
							}

							httpRequest.precheck=precheck;
														
							// If interceptor has no errors, execute main handler
							result = await i.__execute(httpRequest)
							 
						}catch(e){
							// An IError below 500 is a decision (bad input, refused): the request journal has
							// it. A 5xx IError is a failure; anything else is a bug — logged with its stack.
							if(ErrorUtils.isError(e)){
								if(!e.httpStatus || e.httpStatus >= 500)
									logError(`${ep} failed`, e)
							}else
								logCrit(`${ep} threw`, e)

							respond(this.failure(e));
							return;
						}

						respond(result);
					}

					return execute() // changed to return, was: execute(), without return

				});// handle incoming request

			}
		}

	

		// final handler
		app.use((req, res, next) => {
			const tme = +new Date()
			this.sendResponse(req.get("Referer")??"",res,{
				error:DefaultErrors.UNKNOWN_REQUEST,
				data:null,
				httpStatus:404
			},tme,req.path,{
				endpoint: req.path,
				headers: req.headers as unknown as any,
				method: req.method,
				data: req.body,
				params: req.params as {[key:string]:string},
				interceptorResult: null,
				raw: req,
				response: undefined,
				files: undefined
			});
		})

		// Graceful stop: no new connections, idle ones closed, requests in progress get up to
		// shutdownTimeoutMs; then whatever is left is cut and the services finalize.
		onDrain(async ()=>{
			APIService.draining = true;
			const limit = this.options.shutdownTimeoutMs ?? 10_000;
			const started = Date.now();
			control.stop();
			server.close();
			server.closeIdleConnections();
			for(const c of wss?.connections ?? []) { try { c.close(1001, "Server restarting"); } catch {} }
			while(this.inFlight > 0 && Date.now() - started < limit)
				await new Promise(r=>setTimeout(r,50));
			if(this.inFlight > 0) logWarn(`Stopping: ${this.inFlight} request(s) still running after ${limit} ms — cut`);
			else logInfo(`Stopping: requests drained in ${Date.now() - started} ms`);
			server.closeAllConnections();
		});

		// The deployer's control channel (control/Control.ts), when it started this process.
		const control = new ControlServer({
			version: this.version,
			inFlight: () => this.inFlight,
			connections: () => new Promise(res => server.getConnections((e, n) => res(e ? null : n))),
		});

		const started = () => {
			logAPI('${APIService.js}','API Service started at: '+(this.options.host ? this.options.host+":" : "")+this.options.port+", with base endpoint:"+this.options.baseEndPoint+", ver.: "+this.version)
			if(!this.options.host)
				logWarn("API Service listens on every network interface: set `host` (e.g. \"127.0.0.1\" behind nginx) or close the port in the firewall");
			// Blue-green standing: background refresh for APIService.blueGreenState / the change signal.
			startBlueGreenWatcher(this.options.blueGreenWatchMs ?? 5000);
			control.start();
		};
		if(this.options.host) server.listen(this.options.port, this.options.host, started);
		else server.listen(this.options.port, started);
	}


	
	
	addNetlog(data:IResponse,req:IRequest,created:number,time:number){

		// если time не передан явно — вычисляем длительность от created до сейчас.
		// created при этом НЕ затираем — это момент старта запроса, нужен для корреляции.
		if(time === 0)
			time = +new Date() - created;


		const logItem:APIServiceNetworkLogItem={
			id: nextLogID++,
			traceId: req?.traceId,
			created: created,
			time: time,
			request:{
				endpoint:req?.endpoint,
				// sanitizeDeep returns COPIES — redacting these in place would corrupt the live
				// request object the app is still serving (headers especially).
				headers:LogService.sanitizeDeep(req?.headers),
				method:req?.method,
				data:this.checkDataLength(req?.data),
				params:LogService.sanitizeDeep(req?.params),
				interceptorResult:LogService.sanitizeDeep(req?.interceptorResult)
			},
			response: this.checkDataLength(data),
		}

		this.netLog.push(logItem);
		
		if(this.netLog.length>100)
			this.netLog.shift()

		if(nextLogID>Number.MAX_SAFE_INTEGER-1000)
			nextLogID=0;
	}


	// Path the WebSocket server answers on: baseEndPoint + endpoint, slashes normalized,
	// no trailing slash ("/api/v1/" + "/ws/" → "/api/v1/ws").
	static webSocketPath(baseEndPoint:string, endpoint?:string):string{
		const joined = "/" + (baseEndPoint ?? "") + "/" + (endpoint || "ws");
		return joined.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
	}

	// Shares the HTTP server: upgrade requests on our path become WebSocket connections.
	// Handshake checks live here (path, Origin, connection limits); authorization and message
	// handling belong to WebSocketServer.
	private attachWebSocketServer(server:http.Server, trustedProxies:Set<string>):WebSocketServer{
		const opt = this.options.websocketServer ?? {};
		const wsPath = APIService.webSocketPath(this.options.baseEndPoint, opt.endpoint);
		if(!opt.onAuthorize && opt.public !== true)
			throw new Error(`WebSocket server at ${wsPath}: set onAuthorize, or public: true to accept every connection without authorization`);
		const maxConnections = opt.maxConnections ?? 1000;
		const maxPerIp = opt.maxConnectionsPerIp ?? 50;
		// Same allow-list the HTTP origin check uses (already normalized by init).
		const allowedOrigins = new Set(this.options.corsHostWhiteList ?? []);
		const perIp = new Map<string, number>();

		const wss = new WsServer({ noServer: true, maxPayload: opt.maxPayload ?? 256 * 1024 });
		const gateway = new WebSocketServer(opt.onAuthorize ?? null, {
			authTimeoutMs: opt.authTimeoutMs ?? 10000,
			maxMessagesPerSecond: opt.maxMessagesPerSecond ?? 20,
		});

		const refuse = (socket:import("stream").Duplex, status:number, text:string)=>{
			socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			socket.destroy();
		};

		server.on("upgrade", (req:IncomingMessage, socket:import("stream").Duplex, head:Buffer)=>{
			// A reset mid-handshake must not surface as an uncaught exception.
			socket.on("error", ()=>{});
			let pathname = "";
			try{ pathname = new URL(req.url ?? "", "http://localhost").pathname.replace(/\/+$/, "") || "/"; }catch{}
			if(pathname !== wsPath){
				// Another upgrade listener (attached by the app via REQ_HTTP_SERVER) may own this
				// path; only when we are the sole listener is the request ours to refuse.
				if(server.listeners("upgrade").length === 1)
					refuse(socket, 404, "Not Found");
				return;
			}

			const ip = clientIp(req, trustedProxies);
			if(BlockedIps.isBlocked(ip)){
				BlockedIps.noteHit(ip);
				return refuse(socket, 403, "Forbidden");
			}

			// Browsers always send Origin and it can't be forged from a page: without this check
			// any site could open a socket riding the user's cookies (cross-site WebSocket hijacking).
			const origin = req.headers.origin;
			if(origin){
				if(APIService.originVerdict(origin, req.headers.host, allowedOrigins, this.anyOrigin) === "denied"){
					logWarn(`WebSocket refused from ${ip}: origin not allowed (${String(origin).slice(0, 200)})`);
					return refuse(socket, 403, "Forbidden");
				}
			}

			if(wss.clients.size >= maxConnections){
				logWarn(`WebSocket refused from ${ip}: connection limit ${maxConnections} reached`);
				return refuse(socket, 503, "Service Unavailable");
			}
			if((perIp.get(ip) ?? 0) >= maxPerIp){
				logWarn(`WebSocket refused from ${ip}: per-IP limit ${maxPerIp} reached`);
				return refuse(socket, 429, "Too Many Requests");
			}

			// Without a verifyClient, ws runs this callback synchronously — or never, when it
			// rejects the handshake itself (bad headers); nothing is reserved before it runs.
			wss.handleUpgrade(req, socket, head, ws => {
				perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
				ws.once("close", ()=>{
					const n = (perIp.get(ip) ?? 1) - 1;
					if(n > 0) perIp.set(ip, n); else perIp.delete(ip);
				});
				gateway.accept(ws, req, ip);
			});
		});
		if(!opt.onAuthorize)
			logWarn(`WebSocket server at ${wsPath} is public (public: true) — every connection is accepted without authorization`);
		logAPI(`WebSocket server attached at ${wsPath}`);
		return gateway;
	}

	async sendResponse(ref:string,res:Response,data:IResponse<any>,requestTime:number,endpoint?:string,req?:IRequest){

		const ignoreHttpLogging = data.ignoreHttpLogging ?? false;
		delete data.ignoreHttpLogging;

		if(data.blockResponse){
			if(!ignoreHttpLogging)
				logAPI("Response blocked")
			if(req && !ignoreHttpLogging)
				this.addNetlog(data,req,requestTime,0);
			return;
		}

		if(!ignoreHttpLogging)
			S_STAT_REGISTRATE_REQUEST.invoke({ ...data, endpoint: data.endpoint ?? endpoint })

		
		if(this.options.postproducer){
			try{
				data = await this.options.postproducer(req,res,data,requestTime,endpoint);
			}catch(e){
				logError("Postproducer error",e)
			}
		}

		if(ErrorUtils.isError(data))
			data = {error:data as IError,data:null}
		
        data.responseTime = (+new Date()) - requestTime;
		// The current id, not the one from the start: a signed microservice call adopts its caller's.
		const traceId = Trace.current() ?? req?.traceId;
		if(traceId){
			data.traceId = traceId;
			if(req) req.traceId = traceId;
			if(!res.headersSent) res.setHeader("X-Request-Id", traceId);
		}
        data.core = this.version
        data.endpoint = endpoint ?? "no_endpoint"
		
		if(this.options.appVersion)
			data.version=this.options.appVersion
		
		
	
        if(res.socket?.destroyed || res.writableEnded || res.headersSent || (res.destroyed !== undefined && res.destroyed)){
			if(!ignoreHttpLogging)
				logAPI("Connection already closed, can't send response for: "+data.endpoint)
		}else{
			try{

				if(data.file){

					// On POSIX a backslash is a legal filename char, not a separator — but paths reaching
					// here are meant as filesystem paths, so on a POSIX OS normalize win32-style separators
					// (callers sometimes build paths with a win32 `path` module). Gate on the real OS via
					// process.platform, NOT path.sep — the `path` module can be win32 even on Linux if
					// process.platform was patched when it loaded. On a real Windows host, leave as-is.
					const normalizedFile = process.platform === "win32" ? data.file : data.file.replaceAll("\\", "/");

					// res.sendFile requires an absolute path — a relative one makes Express throw
					// synchronously ("path must be absolute..."), which otherwise gets swallowed below
					const filePath = path.isAbsolute(normalizedFile) ? normalizedFile : path.resolve(normalizedFile);

					const onSendFileError = (err:any)=>{
						if(!ignoreHttpLogging)
							logError("Can't send file: "+filePath)

						//TODO мы уже отдаем файл и ошбика может быть не отправлена

						if(!res.headersSent && !res.writableEnded){
							res.status(500).send({ error: DefaultErrors.CANT_SEND_FILE, data: null });
							return;
						}else{
							try { (res as any).destroy?.(err); } catch {}
							return;
						}
					}

					try{
						res.sendFile(filePath,err=>{
							if(err){
								onSendFileError(err);
							}else{
								if(req && !data.ignoreHttpLogging)
									this.addNetlog(data,req,requestTime,0);
							}
						})
					}catch(e){
						// sendFile can throw synchronously (e.g. invalid path) before the callback ever runs
						onSendFileError(e);
					}

					return;
				}
				
				if(data.redirect){
					res.redirect(data.redirect);
					if(!data.ignoreHttpLogging)
						logAPI("redirect: "+data.redirect)
				}else{
					// setup headers
					if(data.headers){
						for(let i in data.headers)
							res.setHeader(i,data.headers[i]);
					}

					if(data.error && data.error.httpStatus && data.error.httpStatus>99)
						res.statusCode = data.error.httpStatus
					else
						res.statusCode=data.httpStatus ?? 200
					
					if(data.rawResponse){
						res.send(data.data)
						if(!ignoreHttpLogging)
							logAPI(this.checkDataLength(data))
					}
					else{
						// An error's `stack` (chained causes, internal hosts) stays in the log and the
						// monitor; in production it never reaches the client.
						res.send(this.options.isProductionEnvironment ? APIService.withoutStack(data) : data);
						if(!ignoreHttpLogging)
							logAPI(this.checkDataLength(data))
					}
				}
			}catch(e){
				logError(e)
			}
		}

		if(req && !ignoreHttpLogging)
			this.addNetlog(data,req,requestTime,0);
    }


	// What the request journal keeps of a body: redacted first, then shortened (LogService.snapshot).
	checkDataLength(data:any,result?:any,lvl?:number):any{
		return LogService.snapshot(data) ?? "";
	}

}
