import { Req } from "../../signal/Signal";
import { BaseService } from "../BaseService";
import { IDeployerUser } from "../APIService";
import { ConfigService, IConfig,IProjectState,REQ_DEPLOYMENT_CONFIG,S_CONFIG_UPDATED,projectNameProblem } from "./ConfigService";
import { UploadedFile } from "express-fileupload";
import path from "path";
import { logError, logWarn, logInfo, LogService } from "../LogService";
import { ErrorUtils } from "../structures/DefaultErrors";
import { Http } from "../http/Http";
import { UID } from "../helper/UID";
import { ValidationModel, Validator } from "../helper/Validator";
import { IDeploymentNotifier, Notifier } from "./Notifier";
import { sendTelegram, telegramText } from "./TelegramNotifier";
import { transportProblem } from "./resolveConfig";
import { IError } from "../structures/Interfaces";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import fs from "fs";
import crypto from "crypto"
import { Watchdog } from "./Watchdog";
import { NginxHelper, DEFAULT_SERVER_TEMPLATE } from "./NginxHelper";
import { BLUEGREEN_FILE } from "./BlueGreenState";
import { BackupManager, MAX_BACKUPS } from "./BackupManager";
import { PasswordHash } from "../helper/PasswordHash";
import { IPendingReview, ReviewStore } from "./ReviewStore";
import { SecretsInjector } from "./SecretsInjector";
import { IProcessRunner, Pm2Runner, runnerKind } from "./ProcessRunner";
import { SystemdRunner } from "./SystemdRunner";
import { settingsProblems } from "./SystemdUnit";
import { controlCall, controlSocketPath } from "../control/Control";
import { IpAllowList } from "../helper/IpAllowList";
import { ISignedAuthVerdict } from "../interceptors/InterceptorSignedAuth";

const _TSetup={
    
    // A user signs in with a signature (publicKey: base64 SPKI Ed25519, made by `bmfk deploy-key`)
    // or, until moved over, a password hash. With a publicKey, the password is not accepted.
    users:[{
        login:"",
        password:"",
        $__password_optional:true,
        publicKey:"",
        $__publicKey_optional:true,
    }] as const,

    // Default (absent or true): only signed requests are accepted. false lets password users in too.
    require_signature:true,
    $__require_signature_optional:true,

    watchdog:true,
    $__watchdog_optional:true,

    notifier:{
        URL:"",
        KEY:"",
    },

    $__notifier_optional:true,

    // Telegram: one message per deploy, switch, restore, review and failure. Re-read on change.
    telegram:{
        bot:"",
        chat:"",
        topic:0,
        $__topic_optional:true,
    },
    $__telegram_optional:true,

    // Override for the URL deployed apps use to query their slot state (pckg/slot).
    // Default: http://127.0.0.1:<deployer port><baseEndPoint>pckg/slot — the app always runs on
    // the same host as the deployer. Set this only if the deployer isn't reachable on loopback.
    status_url:"",
    $__status_url_optional:true,

    // Addresses allowed to use the deployer (deploy, activate, status, backups, restore): single
    // IPs and CIDR subnets, IPv4 and IPv6 — e.g. ["203.0.113.7", "10.8.0.0/24", "2001:db8::/48"].
    // Checked before credentials. Absent or empty → any address (a warning is logged).
    // Not applied to pckg/slot: deployed apps ask it over loopback with their own token.
    allowed_ips:[""],
    $__allowed_ips_optional:true,

    // Deploy reviewers (projects opt in with "review" in their config). The password is a hash from
    // `npx bmfk hash-password`; 2FA is enrolled at the first sign-in on the review page.
    reviewers:[{
        login:"",
        password:"",
        email:"",
    }] as const,
    $__reviewers_optional:true,

    // Public address of the review page, reachable by reviewers (e.g. over VPN, within allowed_ips):
    // "https://deployer.example.com/api/review/html" (<baseEndPoint>review/html). Links are <review_url>#<token>.
    review_url:"",
    $__review_url_optional:true,

    // Default directory for project secrets files (projects opt in with "secrets" in their config).
    secrets_dir:"",
    $__secrets_dir_optional:true
} as const;

export type TDeployerSetup = ValidationModel<typeof _TSetup>
// The setup.json schema, for tools that build or check it (e.g. `bmfk setup-config`).
export const SETUP_MODEL = _TSetup;    

export interface IDeployerServiceOptions{
    projects_path:string; // path to the projects directory
    setup_path:string;
    // Filled in by APIService (not by the user): where this deployer listens, used to build the
    // default loopback statusUrl written into each blue-green slot's .bluegreen.json.
    selfPort?:number;
    selfBaseEndPoint?:string;
}

export const REQ_DEPLOYMENT_PROCEED=new Req<{auth:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string,token:string,files:{file:UploadedFile}},any>(undefined,"REQ_DEPLOYER_SERVICE")
export const REQ_DEPLOYMENT_SWITCH=new Req<{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string,token:string,scheme?:"blue"|"green"},any>(undefined,"REQ_DEPLOYER_SWITCH")
export const REQ_DEPLOYMENT_STATUS=new Req<{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name?:string},any>(undefined,"REQ_DEPLOYER_STATUS")
// Read-only slot query for deployed apps: auth is the per-project statusToken, not a deployer user.
export const REQ_DEPLOYMENT_SLOT=new Req<{name:string,token:string,slot?:"blue"|"green"},any>(undefined,"REQ_DEPLOYER_SLOT")
export const REQ_DEPLOYMENT_BACKUPS=new Req<{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string},any>(undefined,"REQ_DEPLOYER_BACKUPS")
// The public key of a deployer user (for signed requests), or null.
export const REQ_DEPLOYER_PUBLIC_KEY=new Req<string,string|null>(undefined,"REQ_DEPLOYER_PUBLIC_KEY")
export const REQ_DEPLOYMENT_RESTORE=new Req<{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string,token:string,backup:string},any>(undefined,"REQ_DEPLOYER_RESTORE")

export class DeployerService extends BaseService{
    // State files are parsed on every pckg/slot query — keep history bounded so they don't grow forever.
    private static MAX_HISTORY = 200;
    private static _trimHistory(state: IProjectState){
        const h = state.history as unknown as any[];
        if(Array.isArray(h) && h.length > DeployerService.MAX_HISTORY)
            h.splice(0, h.length - DeployerService.MAX_HISTORY);
    }

    options:IDeployerServiceOptions;
    setup:TDeployerSetup|null=null;
    notifier:IDeploymentNotifier|null=null;

    // Fire-and-forget: a slow or failing Telegram never holds up a deploy.
    private telegram(project: string, status: string, user: string) {
        const t = this.setup?.telegram;
        if (t?.bot && t?.chat) void sendTelegram({ bot: t.bot, chat: String(t.chat), topic: t.topic || undefined }, telegramText(project, status, user));
    }
    busy=new Map<string,boolean>();
    reviews!:ReviewStore;
    // What starts deployed projects, by the project's "runner". Replaced in tests.
    runners: { pm2: IProcessRunner, systemd: IProcessRunner } = { pm2: new Pm2Runner(), systemd: new SystemdRunner() };

    // The runner of a project, or null when nothing is started ("runner": "none", or "pm2": false).
    // A bad "runner" or "systemd" block throws, before a deploy or restore writes anything.
    private _runnerFor(found: IConfig, project: string): IProcessRunner | null {
        const kind = runnerKind(found as any);
        if(typeof kind !== "string"){
            logError(`"${project}": ${kind.error}`);
            throw {code:69,message:"The project's runner is not valid.",details:kind.error,httpStatus:400}
        }
        if(kind === "systemd"){
            const problems = settingsProblems((found as any).systemd);
            if(problems.length){
                logError(`"${project}": ${problems.join("; ")}`);
                throw {code:68,message:"The systemd settings of the project are not valid.",details:problems.join("; "),httpStatus:400}
            }
        }
        return kind === "none" ? null : this.runners[kind];
    }
    private _setupWatchDebounceTimer: NodeJS.Timeout | null = null;
    private _lastSetupHash: string | null = null;
    
    constructor(options:IDeployerServiceOptions){
        super("DeployerService");
        this.options = options;
    }

    async init():Promise<void>{
        this.reviews = new ReviewStore(this.options.projects_path);
        const sweep = () => { for (const p of this.reviews.sweep()) logWarn(`Review of "${p}" expired — the uploaded archive was removed`); };
        sweep();
        setInterval(sweep, 10 * 60 * 1000).unref();
        super.init();

        const cs = new ConfigService(this.options.projects_path);
        await cs.init();

        // Initial load — MUST succeed. Service can't start with a broken setup.
        const initial = await this._loadSetup();
        if (!initial) {
            throw new Error("Setup file missing/invalid at start — cannot start deployer");
        }
        this.setup = initial;
        this._warnPlaintextUsers();
        this._lastSetupHash = crypto.createHash("md5").update(JSON.stringify(initial)).digest("hex");

        // Notifier + Watchdog are start-once. Live-reload only refreshes fields consulted
        // per-request (users list). If you need to change notifier URL/KEY or toggle watchdog,
        // restart the service — they don't have safe teardown semantics.
        if (this.setup.notifier?.URL && this.setup.notifier?.KEY) {
            this.notifier = new Notifier({URL: this.setup.notifier.URL, KEY: this.setup.notifier.KEY});
            await this.notifier.init();
        }
        if (this.setup.watchdog) {
            const wd = new Watchdog(this.notifier, (project, status) => this.telegram(project, status, "watchdog"));
            await wd.init();
        }

        // Watch setup.json for live-reload — same pattern as ConfigService: debounce fs.watch
        // bursts and re-scan periodically as safety net for lost inotify handles.
        this._watchSetup();

        REQ_DEPLOYMENT_PROCEED.listener=async data=>this.proceed(data);
        REQ_DEPLOYMENT_SWITCH.listener=async data=>this.switchSlot(data);
        REQ_DEPLOYMENT_STATUS.listener=async data=>this.status(data);
        REQ_DEPLOYMENT_SLOT.listener=async data=>this.slotState(data);
        REQ_DEPLOYMENT_BACKUPS.listener=async data=>this.listBackups(data);
        REQ_DEPLOYMENT_RESTORE.listener=async data=>this.restoreBackup(data);
        REQ_DEPLOYER_PUBLIC_KEY.listener=async login=>(this.setup?.users ?? []).find(u => u.login === login)?.publicKey || null;

        // Review settings span setup.json and the project configs: re-check whenever either changes.
        await this._checkReviewSetup();
        S_CONFIG_UPDATED.subscribe(() => { this._checkReviewSetup(); });
    }

    // Says at startup (not at the first upload) when a project's review can't work, and which
    // reviewers would be refused at sign-in.
    private async _checkReviewSetup(){
        try{
            const plain = (this.setup?.reviewers ?? []).filter(r => r?.login && !PasswordHash.isHash(r.password)).map(r => r.login);
            if(plain.length)
                logError(`Deployer: reviewer password stored as plain text for ${plain.map(l=>'"'+l+'"').join(", ")} — these reviewers can't sign in; store a hash: npx bmfk hash-password`);
            const configurations = await REQ_DEPLOYMENT_CONFIG.request();
            for(const c of configurations.values()){
                if(!c?.review) continue;
                const problem = this._reviewSetup(c).error;
                if(problem) logError(`Deployer: review of "${c.name}" can't work — ${problem}. Uploads of this project will be refused until it is fixed.`);
            }
        }catch(e:any){
            logWarn("Deployer: can't check the review setup: " + (e?.message ?? e));
        }
    }

    // Reads, parses and validates setup.json. Returns the parsed setup on success.
    // Returns null on ANY failure (missing file / bad JSON / validation errors) —
    // callers decide whether to hard-fail (init) or keep the previous good copy (reload).
    // Logs all failure reasons so operator sees what's wrong.
    private async _loadSetup(): Promise<TDeployerSetup | null> {
        const setupFile = path.resolve(this.options.setup_path, "setup.json");
        if (!fs.existsSync(setupFile)) {
            logError("Setup file not found: " + setupFile);
            return null;
        }
        let raw: string;
        try {
            raw = fs.readFileSync(setupFile, "utf-8");
        } catch (e: any) {
            logError("Failed to read setup file: " + e.message);
            return null;
        }
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            logError("Failed to parse setup.json: " + e.message);
            return null;
        }
        const errors = await Validator.validateStructure(_TSetup, parsed);
        if (errors && errors.length > 0) {
            logError("Setup validation failed: " + JSON.stringify(errors));
            return null;
        }
        // A typo in the allow-list must not silently open (or close) the deployer: the whole
        // setup is refused and the previous good one stays in force.
        const ips = DeployerService.buildAllowList(parsed.allowed_ips);
        if (ips.error) {
            logError("Setup validation failed: allowed_ips — " + ips.error);
            return null;
        }
        return parsed as TDeployerSetup;
    }

    // Try to reload setup from disk. On failure, keep the previously-loaded good copy —
    // operator gets a warning in the log but the service keeps running with the last known
    // valid setup. Skips log noise if the file content is unchanged (safety-polling hits
    // this every 60s even when nothing changed).
    private async _reloadSetup(): Promise<void> {
        const fresh = await this._loadSetup();
        if (!fresh) {
            logWarn("Setup reload failed — keeping previous good setup in memory");
            return;
        }
        const hash = crypto.createHash("md5").update(JSON.stringify(fresh)).digest("hex");
        if (hash === this._lastSetupHash) return;   // no real change, silent
        this._lastSetupHash = hash;
        this.setup = fresh;
        this._warnPlaintextUsers();
        this._checkReviewSetup();
        logWarn("Setup reloaded from disk (users list refreshed live; notifier/watchdog need service restart to change)");
    }

    // Watch setup.json for changes. Same shape as ConfigService's watch:
    //   - fs.watch with 200ms debounce (editors fire multiple events per save);
    //   - 60s safety-polling to recover from lost inotify handles (dir rm+mkdir on Linux).
    private _watchSetup(): void {
        try {
            fs.watch(this.options.setup_path, (_eventType, filename) => {
                if (filename !== "setup.json") return;
                if (this._setupWatchDebounceTimer) clearTimeout(this._setupWatchDebounceTimer);
                this._setupWatchDebounceTimer = setTimeout(() => {
                    this._setupWatchDebounceTimer = null;
                    this._reloadSetup();
                }, 200);
            });
        } catch (e: any) {
            logError("Failed to fs.watch setup file: " + e.message);
        }
        setInterval(() => { this._reloadSetup(); }, 60_000).unref();
    }

    async proceed(data:{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string,token:string,files:{file:UploadedFile}}){


        // First gate: caller must be one of the configured deployer users.
        // Silent on failure (log only) — mailing on this would let anyone flood the
        // notification channel by hammering the endpoint.
        const auth = await this._checkUserAuth(data.auth, data.authLogin, data.ip, data.sig);
        const user = auth.user;
        if (!user) {
            logError("Deploy rejected: user auth failed")
            return {error:{code:20,message:auth.error ?? "Unauthorized.",httpStatus:auth.status ?? 401}}
        }
        
        
        const configurations = await REQ_DEPLOYMENT_CONFIG.request();
        const project = await this._projectByToken(configurations, data.name, data.token);
        if(project.error)
            return {error:{code:12,message:project.error,httpStatus:400}}
        let found:IConfig|undefined = project.config;

        if(!found){
            // Same reasoning as the auth-gate above: log only, no notification.
            logError("Deploy rejected: wrong token and/or name")
            return {error:{code:12,message:"Wrong token and/or name.",httpStatus:400}}
        }

        if(this.busy.get(found.name))
            return {error:{code:13,message:"Deployment already in progress.",httpStatus:400}}

        // Under review: hold the archive and ask the reviewers instead of deploying now.
        if(found.review)
            return await this._queueForReview(found, user, data.files.file as UploadedFile, data.ip);

        return await this._deploy(found, user, configurations, data.name, { file: data.files.file as UploadedFile });
    }

    // Runs a deploy end to end: backup, copy, unpack, config, migrate, pm2, nginx, state. The
    // archive comes either straight from the upload or from a file (an approved pending review).
    // Callers have already verified the deployer user and the project token.
    private async _deploy(found:IConfig, user:IDeployerUser, configurations:Map<string,IConfig>, name:string,
        source:{ file?: UploadedFile, archivePath?: string }){

        if(this.busy.get(found.name))
            return {error:{code:13,message:"Deployment already in progress.",httpStatus:400}}

        const realName = found.name;
        const data = { name };
        this.busy.set(realName,true);
        let baselineStaged = false;

        try{

            found = structuredClone(found) as IConfig; // deep clone so we can modify it without affecting the original config

            // Validate where we are about to write before anything happens — backup, upload or
            // creating a slot. For blue-green the project root itself is never wiped (slots are).
            const allConfigs = Array.from(configurations.values());
            const isBGProject = !!(found.bluegreen && found.bluegreen.blue_config && found.bluegreen.green_config);
            const rootProblem = this._destinationProblem(found.destination, !isBGProject && !!found.unpack && !found.ignoreDirectoryClean,
                allConfigs, found.destination);
            if(rootProblem){
                logError("Deploy rejected: unsafe destination: " + rootProblem);
                throw {code:19,message:"Unsafe destination.",details:rootProblem,httpStatus:400}
            }
            
            // Sanitize the client-supplied filename: strip any path components and
            // restrict to a safe character set so it can never break out of the
            // destination directory or be interpreted as a shell argument.
            const sourceName = source.file ? source.file.name : path.basename(source.archivePath ?? "");
            const safeName = (path.basename(sourceName || "").replace(/[^a-zA-Z0-9._-]/g, "_")) || "upload";
        
            

            // load project state
            let projectState:IProjectState|null=null;
            let projectStatePath=null;
            // Tracks whether this is the FIRST deploy of a B/G project. Only then should nginx
            // upstream be initialized from proceed — subsequent deploys of the inactive slot
            // must NOT touch nginx (would point traffic at a not-yet-active slot).
            let projectStateWasCreated = false;

            if(found.bluegreen && found.bluegreen.blue_config && found.bluegreen.green_config){
                projectStatePath = path.resolve(this.options.projects_path,data.name+"_state_.json");
                if(fs.existsSync(projectStatePath)){
                    try{
                        projectState = JSON.parse(fs.readFileSync(projectStatePath,"utf-8"));
                    }catch(e:any){
                        logError("Failed to load project state: " + e.message);
                    }
                }

                if(!projectState){
                    projectState = {
                        active:"blue",
                        lastDeployed:"blue",
                        history:[]
                    }
                    projectStateWasCreated = true;
                }else{
                    projectState.lastDeployed = projectState.active === "blue" ? "green" : "blue";
                }

                // Read-only token for the app's "am I live?" query. Generated once, then reused,
                // so both slots' .bluegreen.json stay valid across deploys.
                if(!projectState.statusToken)
                    projectState.statusToken = crypto.randomBytes(32).toString("hex");
                
                projectState.history.push({
                    slot: projectState.lastDeployed,
                    action:"deploy",
                    user:user.login,
                    at:Date.now()
                })
                DeployerService._trimHistory(projectState);

                const subdir = projectState.lastDeployed;
                const deployPath = path.resolve(found.destination, subdir);
                fs.mkdirSync(deployPath, { recursive: true });   // no-op if exists
                found.destination = deployPath;

                // Merge (not replace) the base config with the slot-specific overlay.
                // Base holds values shared by both slots (DOMAIN, DB creds, feature flags);
                // blue_config / green_config hold slot-specific values (PORT, PM2 name suffix,
                // per-slot feature toggles). Slot wins on key collision.
                if(projectState && found.bluegreen){
                    const baseConfig = found.config ?? {};
                    if(projectState.lastDeployed === "blue" && found.bluegreen.blue_config){
                        found.config = { ...baseConfig, ...found.bluegreen.blue_config };
                    }else if(projectState.lastDeployed === "green" && found.bluegreen.green_config){
                        found.config = { ...baseConfig, ...found.bluegreen.green_config };
                    }
                }

                found.name = data.name + "-" + projectState.lastDeployed;

                const slotProblem = this._destinationProblem(found.destination, !!found.unpack && !found.ignoreDirectoryClean,
                    allConfigs, path.dirname(path.resolve(found.destination)));
                if(slotProblem){
                    logError("Deploy rejected: unsafe slot destination: " + slotProblem);
                    throw {code:19,message:"Unsafe destination.",details:slotProblem,httpStatus:400}
                }
            }
                
            

            // What runs the process — checked before anything is written, like the secrets below.
            const runner = this._runnerFor(found, realName);

            // Secrets file: resolved before anything is written, so a bad setting can't leave a
            // half-deployed project behind.
            let secretsFile: string | null = null;
            if(found.secrets){
                const slotName = projectState ? projectState.lastDeployed : null;
                const resolved = SecretsInjector.resolvePath(realName, slotName, found.secrets, this.setup?.secrets_dir,
                    projectState ? path.dirname(path.resolve(found.destination)) : found.destination);
                if(resolved.error){
                    logError(`Deploy of "${realName}" rejected: ${resolved.error}`);
                    throw {code:64,message:"Secrets are misconfigured.",details:resolved.error,httpStatus:500}
                }
                secretsFile = resolved.path!;

                // The secrets file is 0600 and owned by the deployer's user. pm2 started by the
                // deployer runs the app as that same user — unless the project switches user, and
                // then the app couldn't read its own config and would not start.
                if(runner?.kind === "pm2"){
                    const attrs = Pm2Runner.attributesFor(found, projectState);
                    const switchesUser = attrs.find(a => /^--(uid|gid|user)(=|$)/.test(a));
                    if(switchesUser){
                        const why = `pm2 runs this project as another user (${switchesUser}), which couldn't read the secrets file`;
                        logError(`Deploy of "${realName}" rejected: ${why}`);
                        throw {code:65,message:"Secrets can't be used with this pm2 setup.",details:why+" — remove \"secrets\" from the project config or the user switch from its pm2 attributes",httpStatus:400}
                    }
                }
            }

            const uploadPath = path.resolve(found.destination, UID.generate() + "_" + safeName);
            

            // BACKUP — before anything lands in the destination: the uploaded archive is copied INTO
            // it right below, so a backup taken later would contain it. Fail closed: with backup
            // enabled, overwriting without a safety copy is exactly what the flag forbids.
            if(found.backup){
                try{
                    const slot = projectState ? projectState.lastDeployed as "blue"|"green" : null;
                    const backupName = await BackupManager.create(found.destination, realName, slot, user.login, "deploy");
                    if(backupName){
                        logInfo(`Backup created: ${backupName}`);
                        const removed = await BackupManager.prune(path.dirname(path.resolve(found.destination)), realName, MAX_BACKUPS);
                        if(removed.length) logInfo(`Old backups removed: ${removed.join(", ")}`);
                    }
                }catch(e:any){
                    logError("Backup failed, deploy aborted: " + (e?.message ?? e));
                    this.telegram(found.name, "error-backup", user.login);
                    if(found.email && found.email.length > 0){
                        for(let email of found.email)
                            this.notifier?.notifyEmailStatus(email,"error-backup",found.name,user.login)
                    }
                    throw {code:54,message:"Backup failed, deploy aborted — nothing was changed.",details:String(e?.message ?? e),httpStatus:500}
                }
            }

            // COPY!
            const result = source.file
                ? await this.upload(source.file,uploadPath)
                : this._copyArchive(source.archivePath!, uploadPath);
            if(ErrorUtils.isError(result)){
                this.telegram(found.name, "error-copy", user.login);
                if(found.email && found.email.length > 0){
                    for(let email of found.email){
                        this.notifier?.notifyEmailStatus(email,"error-copy",found.name,user.login)
                    }
                }
                
   
                throw result
            }


            // Projects under review keep the raw archive of their last successful deploy — the
            // "before" side of the next review's diff. Staged now (unpack deletes the archive),
            // committed only if the whole deploy succeeds.
            if(found.review){
                try{ this.reviews.stageBaseline(realName, uploadPath); baselineStaged = true; }
                catch(e:any){ logWarn(`Review baseline for "${realName}" not kept: ${e?.message ?? e}`); }
            }

            // UNPACK! (AND INSTALL IF NEEDED)
            if(found.unpack){
                const unpackResult = await this.unpack(found.destination,uploadPath,found.install,found.ignoreDirectoryClean,found.omitDev,realName)
                if(ErrorUtils.isError(unpackResult)){
                    this.telegram(found.name, "error-unpack", user.login);
                    if(found.email && found.email.length > 0){
                        for(let email of found.email){
                            this.notifier?.notifyEmailStatus(email,"error-unpack",found.name,user.login)
                        }
                    }
                    

                    throw unpackResult
                }
            }

            if (found.chmod && found.chmod>1) {
                // Last octal digit = permissions for every other user on the machine. Readable
                // exposes substituted passwords; writable lets anyone change the running code.
                const others = Number(String(found.chmod).slice(-1));
                if (others & 2)
                    logWarn(`"${realName}": chmod ${found.chmod} makes the deployed files WRITABLE by every user on the server — anyone can change the code that runs`);
                else if (others & 4)
                    logWarn(`"${realName}": chmod ${found.chmod} makes the deployed files readable by every user on the server${found.secrets ? "" : " — including the substituted config values"}`);
                try{
                    logInfo("Try to execute: ",`chmod -R ${found.chmod} ${found.destination}`)
                    execFileSync("chmod", ["-R", String(found.chmod), found.destination])
                }catch(e){
                    logError("Can't execute chmod",e)
                }
            }


            // setup config
            if(found.config){
                const inject = secretsFile;
                if(secretsFile){
                    SecretsInjector.write(secretsFile, found.config);
                    const unreadable = SecretsInjector.verify(secretsFile, found.config);
                    if(unreadable){
                        logError(`Deploy of "${found.name}" stopped: ${unreadable}`);
                        throw {code:66,message:"The secrets file can't be read back — the app was not started.",details:unreadable,httpStatus:500}
                    }
                    logInfo(`Secrets of "${found.name}" written to ${secretsFile}`);
                    // ES modules have no require(): the secrets file can't be read from them.
                    let esm = false;
                    try{
                        const pkg = JSON.parse(fs.readFileSync(path.resolve(found.destination,"package.json"),"utf-8"));
                        esm = pkg?.type === "module";
                    }catch{ /* no package.json — CommonJS by default */ }
                    if(esm){
                        logError(`Deploy of "${found.name}" stopped: secrets are on, but the project is an ES module ("type": "module") — values would be written into the code`);
                        throw {code:67,message:"Secrets file mode doesn't support ES modules — the app was not started.",details:"remove `secrets` from the project config to substitute values into the code knowingly",httpStatus:500}
                    }
                }
                const onDisk: string[] = [];
                await this.applyConfig(found.destination,found.config,{ secretsFile: inject, onDisk })
            }

            // Blue-green: tell each slot who it is and how to ask whether it's live. Written into
            // BOTH slot dirs (not just the one being deployed) so a slot deployed before this
            // feature existed gets its file on the next deploy. Before pm2 start, so the fresh
            // process finds it immediately.
            if(projectState && projectStatePath){
                this._writeBlueGreenFiles(data.name, projectState, path.dirname(found.destination));
            }

     

            // MIGRATE — after config substitution (migrations need the real DB settings, not
            // placeholders) and before the process (re)starts, so new code never boots against an
            // old schema. A failure stops the deploy here: the process is not restarted.
            if(found.migrate){
                const migrateErr = await this._runMigrate(found.destination);
                if(migrateErr){
                    this.telegram(found.name, "error-migrate", user.login);
                    if(found.email && found.email.length > 0){
                        for(let email of found.email)
                            this.notifier?.notifyEmailStatus(email,"error-migrate",found.name,user.login)
                    }
                    throw migrateErr
                }
            }

            // RUN OR RESTART (pm2 or systemd)
            if(runner){
                const runResult = await runner.start(found, {
                    name: found.name, project: realName,
                    slot: projectState ? projectState.lastDeployed as "blue"|"green" : null,
                    destination: found.destination, config: found.config as Record<string, unknown>,
                }, projectState);
                if(runResult){
                    this.telegram(found.name, "error-" + runner.kind, user.login);
                    if(found.email && found.email.length > 0){
                        for(let email of found.email){
                            this.notifier?.notifyEmailStatus(email,"error-" + runner.kind,found.name,user.login)
                        }
                    }
                    throw runResult
                }
            }

            // NGINX INTEGRATION — render upstream + seed server config ONLY when this deploy
            // materially changes what nginx should route to:
            //   - non-B/G project: no projectState, always render (idempotent);
            //   - B/G project on FIRST deploy: state was just created, active === lastDeployed,
            //     nginx must be initialized to point at this port;
            //   - B/G project on subsequent deploy of the INACTIVE slot: skip — active hasn't
            //     changed, and pointing nginx at the not-yet-switched slot would move traffic
            //     to code that isn't validated yet. switchSlot handles the flip separately.
            if (found.nginx?.config_dir && (!projectState || projectStateWasCreated)) {
                const activeCfg = (found.config ?? {}) as Record<string, string>;
                const nginxErr = await this._renderNginx(found, data.name, DeployerService._extractPort(activeCfg));
                if (nginxErr) {
                    this.telegram(found.name, "error-nginx", user.login);
                    if(found.email && found.email.length > 0){
                        for(let email of found.email){
                            this.notifier?.notifyEmailStatus(email,"error-nginx",found.name,user.login)
                        }
                    }
                    throw nginxErr;
                }
                // Fire the reload hook so nginx picks up the freshly-written upstream/server files.
                // Non-fatal: if it fails, files are still on disk, operator can retry manually.
                const hookErr = await NginxHelper.runHook(found.bluegreen?.on_switch);
                if (hookErr) {
                    logWarn("nginx reload after initial deploy failed: " + hookErr);
                }
            }


            // save project state
            if(projectState && projectStatePath){
                const tmp = projectStatePath + ".tmp";
                fs.writeFileSync(tmp, JSON.stringify(projectState, null, 4), "utf-8");
                fs.renameSync(tmp, projectStatePath);   // atomic on POSIX
            }


            this.telegram(found.name, "done", user.login);
            if(found.email && found.email.length > 0){
                for(let email of found.email){
                    this.notifier?.notifyEmailStatus(email,"done",found.name,user.login)
                }
            }

            if(found.phone && found.phone.length > 0){
                for(let p of found.phone){
                    this.notifier?.notifySMSStatus(p,found.name+" deployment done",user.login)
                }
            }


            // sleep for 10 secs
            if(found.liveness){
                // Capture into consts so TS keeps the narrowing across the async setTimeout closure.
                // `liveness` must come from `found` (already narrowed to string by the outer `if`).
                const conf = found;
                const liveness = found.liveness
                setTimeout(async ()=>{
                    // get liveness probe
                    const result = await Http.get(liveness, { retry: { enabled: true } })
                    if(!result.ok){
                        logError("Liveness check failed for",conf.name)
                        this.telegram(conf.name, "error-liveness", user.login);
                        if(conf.email && conf.email.length > 0){
                            for(let email of conf.email){
                                this.notifier?.notifyEmailStatus(email,"error-liveness",conf.name,user.login)
                            }
                        }
                    }
                },5000)
            }
                    
   
            if(baselineStaged){
                this.reviews.commitBaseline(realName);
                baselineStaged = false;
            }

            // Rich success payload — lets the client display slot info without querying /status.
            // For non-B/G projects, `bluegreen: false` and slot fields are null; the client can
            // gracefully degrade. `activeThisDeploy` tells the operator whether their code is
            // now serving traffic (true) or is standing by and needs an explicit /switch (false).
            return {data: {
                ok: true,
                project: realName,
                bluegreen: !!projectState,
                slot: projectState?.lastDeployed ?? null,
                active: projectState?.active ?? null,
                activeThisDeploy: projectState
                    ? projectState.active === projectState.lastDeployed
                    : true,
            }}
        }finally{
            if(baselineStaged) this.reviews.dropStagedBaseline(realName);
            this.busy.set(realName,false);
        }
    }

    // Who reviews this project and how, resolved against setup.json — or why it can't work.
    private _reviewSetup(found:IConfig): { reviewers?: { login:string, email:string }[], mode?: "any"|"all", ttlMs?: number, error?: string } {
        const review = found.review;
        const logins = Array.from(new Set((review?.reviewers ?? []).map(l => String(l).trim()).filter(Boolean)));
        if(logins.length === 0) return { error: "review.reviewers is empty" };
        const url = String(this.setup?.review_url ?? "");
        if(!/^https?:\/\/[^\s#]+$/.test(url)) return { error: "review_url is not set in setup.json" };
        const insecure = transportProblem(url);
        if(insecure) return { error: "review_url: " + insecure };
        if(!this.notifier) return { error: "the notifier is not configured in setup.json — reviewers can't be emailed" };
        const known = new Map((this.setup?.reviewers ?? []).map(r => [r.login, r]));
        const reviewers: { login:string, email:string }[] = [];
        for(const login of logins){
            const r = known.get(login);
            if(!r) return { error: `reviewer "${login}" is not defined in setup.json` };
            if(!PasswordHash.isHash(r.password)) return { error: `reviewer "${login}" has no password hash in setup.json` };
            if(!/^[^\s@]+@[^\s@]+$/.test(String(r.email ?? ""))) return { error: `reviewer "${login}" has no valid email` };
            reviewers.push({ login, email: r.email });
        }
        const hours = Math.min(Math.max(Number(review?.ttlHours) || 24, 1), 168);
        return { reviewers, mode: review?.mode === "all" ? "all" : "any", ttlMs: hours * 3600_000 };
    }

    // Holds an uploaded archive until the reviewers decide. Nothing in the destination is touched.
    private async _queueForReview(found:IConfig, user:IDeployerUser, file:UploadedFile|undefined, ip?:string){
        const realName = found.name;
        if(!file)
            return {error:{code:14,message:"No archive uploaded.",httpStatus:400}}
        const setup = this._reviewSetup(found);
        if(setup.error){
            logError(`Deploy of "${realName}" not queued — review is misconfigured: ${setup.error}`);
            return {error:{code:61,message:"Review is misconfigured on the deployer.",details:setup.error,httpStatus:500}}
        }

        this.busy.set(realName,true);
        try{
            const { pending, tokens, replaced } = await this.reviews.create(realName, file, {
                uploadedBy: user.login, uploadedFrom: ip ?? null, mode: setup.mode!,
                reviewers: setup.reviewers!.map(r => r.login), ttlMs: setup.ttlMs!,
            });

            // Refuse now what the deploy would refuse later, so nobody reviews an unusable archive.
            const unsafe = DeployerService._unsafeArchiveEntry(this.reviews.archivePath(realName));
            if(unsafe){
                this.reviews.remove(realName);
                logError(`Deploy of "${realName}" not queued — unsafe archive entry: ${unsafe}`);
                return {error:{code:18,message:"Unsafe archive.",details:unsafe,httpStatus:400}}
            }

            const failed: string[] = [];
            for(const r of setup.reviewers!){
                const link = `${this.setup!.review_url}#${tokens[r.login]}`;
                const ok = await this.notifier!.notifyReview(r.email, { project: realName, user: user.login, link, expiresAt: pending.expiresAt, mode: pending.mode });
                if(!ok) failed.push(r.login);
            }
            // "all" needs every reviewer; "any" needs at least one who actually got a link.
            if(failed.length === setup.reviewers!.length || (pending.mode === "all" && failed.length > 0)){
                this.reviews.remove(realName);
                logError(`Deploy of "${realName}" not queued — review mail failed for ${failed.join(", ")}`);
                return {error:{code:62,message:"Review emails could not be sent — the deploy was not queued.",details:`not delivered to: ${failed.join(", ")}`,httpStatus:502}}
            }

            this.reviews.journal(realName, "uploaded", { by: user.login, ip: ip ?? null, sha256: pending.sha256, size: pending.size,
                mode: pending.mode, reviewers: Object.keys(pending.reviewers), notNotified: failed, replacedPrevious: replaced });
            logInfo(`Deploy of "${realName}" by ${user.login} is waiting for review (${pending.mode}: ${Object.keys(pending.reviewers).join(", ")})${replaced ? " — replaced the previous pending upload" : ""}`);
            // No link here: review links are personal and go to each reviewer by mail.
            this.telegram(realName, `waiting for review (${Object.keys(pending.reviewers).join(", ")})`, user.login);
            return {data:{
                ok: true,
                project: realName,
                pendingReview: true,
                mode: pending.mode,
                reviewers: Object.keys(pending.reviewers),
                notNotified: failed,
                expiresAt: pending.expiresAt,
                replacedPrevious: replaced,
            }}
        }catch(e:any){
            this.reviews.remove(realName);
            logError(`Deploy of "${realName}" not queued: ${e?.message ?? e}`);
            return {error:{code:63,message:"Can't store the archive for review.",details:String(e?.message ?? e),httpStatus:500}}
        }finally{
            this.busy.set(realName,false);
        }
    }

    // A reviewer's decision on the upload their session is bound to (project + archive hash).
    // decline → the archive is deleted; accept → recorded, and once the mode is satisfied ("any":
    // this accept, "all": every reviewer) the normal deploy runs from the stored archive.
    async reviewDecide(project:string, sha256:string, reviewer:string, decision:"accept"|"decline", ip:string|null)
        : Promise<{ pending?: IPendingReview, error?: string }> {
        if(this.busy.get(project))
            return { error: "A deploy of this project is running — try again in a moment." };
        const pending = this.reviews.get(project);
        if(!pending || pending.sha256 !== sha256)
            return { error: "This upload was replaced or removed." };
        if(pending.state !== "pending")
            return { error: `This upload is already ${pending.state}.` };
        if(pending.expiresAt < Date.now())
            return { error: "The review time is over — upload again." };
        const mine = pending.reviewers[reviewer];
        if(!mine) return { error: "You are not a reviewer of this upload." };
        if(mine.decision) return { error: `You already chose "${mine.decision}".` };

        mine.decision = decision; mine.at = Date.now(); mine.ip = ip;
        this.reviews.journal(project, decision, { reviewer, ip, sha256 });
        const emails = (await REQ_DEPLOYMENT_CONFIG.request()).get(project)?.email ?? [];

        if(decision === "decline"){
            pending.state = "declined";
            pending.result = { at: Date.now(), message: `Declined by ${reviewer}.` };
            this.reviews.save(pending);
            this.reviews.dropArchive(project);
            logWarn(`Review of "${project}": declined by ${reviewer} from ${ip ?? "unknown"} — archive removed`);
            for(const e of emails) this.notifier?.notifyEmailStatus(e, `declined by ${reviewer}`, project, pending.uploadedBy);
            this.telegram(project, `review declined by ${reviewer}`, pending.uploadedBy);
            return { pending };
        }

        const accepted = Object.entries(pending.reviewers).filter(([, r]) => r.decision === "accept").map(([l]) => l);
        const ready = pending.mode === "any" || accepted.length === Object.keys(pending.reviewers).length;
        logInfo(`Review of "${project}": accepted by ${reviewer} from ${ip ?? "unknown"}${ready ? " — deploying" : ` (${accepted.length}/${Object.keys(pending.reviewers).length})`}`);
        this.telegram(project, `review accepted by ${reviewer}${ready ? " — deploying" : ` (${accepted.length}/${Object.keys(pending.reviewers).length})`}`, pending.uploadedBy);
        if(!ready){
            this.reviews.save(pending);
            return { pending };
        }

        pending.state = "deploying";
        this.reviews.save(pending);
        // Busy from now on: an upload in the gap before _deploy takes over would replace the approved
        // archive. npm ci and migrations can take minutes — longer than an HTTP request should wait.
        // The page polls the state instead.
        this.busy.set(project, true);
        this._deployApproved(project, accepted, sha256).catch(e => logError(`Approved deploy of "${project}" crashed: ${e?.message ?? e}`));
        return { pending };
    }

    private async _deployApproved(project:string, approvers:string[], approvedSha256:string){
        let handedOver = false;
        try{
            return await this._deployApprovedHeld(project, approvers, approvedSha256, () => { handedOver = true; this.busy.set(project, false); });
        }finally{
            if(!handedOver) this.busy.set(project, false);
        }
    }

    // Runs while the project is held busy; `release` is called right before _deploy, which takes the
    // busy flag in the same tick.
    private async _deployApprovedHeld(project:string, approvers:string[], approvedSha256:string, release:() => void){
        const finish = (state:"deployed"|"failed", result:{ message:string, slot?:string|null, activeThisDeploy?:boolean }) => {
            const p = this.reviews.get(project);
            if(!p || p.sha256 !== approvedSha256) return;
            p.state = state;
            p.result = { at: Date.now(), ...result };
            this.reviews.save(p);
            this.reviews.dropArchive(project);
            this.reviews.journal(project, state, { sha256: approvedSha256, approvedBy: approvers, message: result.message });
        };
        const pending = this.reviews.get(project);
        if(!pending) return;
        // Exactly what the reviewers saw, or nothing.
        if(pending.sha256 !== approvedSha256 || pending.state !== "deploying" || !(await this.reviews.archiveIntact(pending))){
            logError(`Approved deploy of "${project}" stopped: the stored archive is not the one that was approved`);
            if(pending.sha256 !== approvedSha256)
                this.reviews.journal(project, "failed", { sha256: approvedSha256, approvedBy: approvers, message: "the pending upload is not the approved one" });
            return finish("failed", { message: "The stored archive changed after the review — nothing was deployed." });
        }
        const configurations = await REQ_DEPLOYMENT_CONFIG.request();
        const found = configurations.get(project);
        if(!found || !found.review){
            logError(`Approved deploy of "${project}" stopped: the project or its review setting is gone`);
            return finish("failed", { message: "The project or its review setting was removed — nothing was deployed." });
        }
        const actor = { login: `${pending.uploadedBy} (approved by ${approvers.join(", ")})`, password: "" } as IDeployerUser;
        try{
            release();
            const res:any = await this._deploy(found, actor, configurations, project, { archivePath: this.reviews.archivePath(project) });
            if(res?.error){
                finish("failed", { message: res.error.message + (res.error.details ? ` (${res.error.details})` : "") });
                return;
            }
            finish("deployed", {
                message: res?.data?.bluegreen && !res.data.activeThisDeploy
                    ? `Deployed to slot ${res.data.slot} — not live yet: run "bmfk activate" to switch traffic.`
                    : "Deployed and live.",
                slot: res?.data?.slot ?? null, activeThisDeploy: res?.data?.activeThisDeploy,
            });
        }catch(e:any){
            const msg = e?.message ? e.message + (e.details ? ` (${typeof e.details === "string" ? e.details : JSON.stringify(e.details)})` : "") : String(e);
            logError(`Approved deploy of "${project}" failed: ${msg}`);
            finish("failed", { message: LogService.sanitize(msg) });
        }
    }

    private _copyArchive(from:string, to:string):IError|null{
        try{
            fs.copyFileSync(from, to);
            return null;
        }catch(e:any){
            return {code:13,message:"Can't copy archive",httpStatus:500,details:String(e?.message ?? e)};
        }
    }




    // Flip the active blue-green slot for a project. Does NOT touch files or PM2 processes —
    // both slots are already running from prior deploys. Only mutates the state file and
    // (optionally) runs the on_switch hook (typically `nginx -s reload`) to redirect traffic.
    //
    // `data.scheme` is optional:
    //   - omitted → switch to `lastDeployed` (normal forward move after a fresh deploy);
    //   - "blue"/"green" explicit → allows rollback to a specific slot.
    async switchSlot(data:{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string,token:string,scheme?:"blue"|"green"}){
        const auth = await this._checkUserAuth(data.auth, data.authLogin, data.ip, data.sig);
        const user = auth.user;
        if (!user) {
            logError("Switch rejected: user auth failed")
            return {error:{code:40,message:auth.error ?? "Unauthorized.",httpStatus:auth.status ?? 401}}
        }

        const configurations = await REQ_DEPLOYMENT_CONFIG.request();
        const project = await this._projectByToken(configurations, data.name, data.token);
        if(project.error)
            return {error:{code:41,message:project.error,httpStatus:400}}
        let found:IConfig|undefined = project.config;
        if(!found){
            logError("Switch rejected: wrong token and/or name")
            return {error:{code:41,message:"Wrong token and/or name.",httpStatus:400}}
        }
        if(!found.bluegreen || !found.bluegreen.blue_config || !found.bluegreen.green_config){
            return {error:{code:42,message:"Project has no blue-green configuration.",httpStatus:400}}
        }
        // Reuse the deploy mutex — both operations mutate state/directory of the same project.
        if(this.busy.get(found.name)){
            return {error:{code:43,message:"Deployment in progress, try again shortly.",httpStatus:409}}
        }

        const realName = found.name;
        this.busy.set(realName, true);
        try{
            const projectStatePath = path.resolve(this.options.projects_path, data.name + "_state_.json");
            if(!fs.existsSync(projectStatePath)){
                return {error:{code:44,message:"Project has never been deployed.",httpStatus:400}}
            }
            let projectState:IProjectState;
            try{
                projectState = JSON.parse(fs.readFileSync(projectStatePath,"utf-8"));
            }catch(e:any){
                return {error:{code:45,message:"Corrupt state file: "+e.message,httpStatus:500}}
            }

            // Determine target slot.
            const target = data.scheme ?? projectState.lastDeployed;
            if(target !== "blue" && target !== "green"){
                return {error:{code:46,message:"Invalid target slot.",httpStatus:400}}
            }
            if(target === projectState.active){
                return {error:{code:47,message:`Slot '${target}' is already active.`,httpStatus:400}}
            }

            const previousActive = projectState.active;
            // "switch" = moving forward to just-deployed slot; "rollback" = returning to older code
            const action:"switch"|"rollback" = target === projectState.lastDeployed ? "switch" : "rollback";
            projectState.active = target;
            projectState.history.push({
                slot: target,
                action,
                user: user.login,
                at: Date.now(),
            });
            DeployerService._trimHistory(projectState);

            // Atomic write BEFORE running the on_switch hook.
            // Rationale: if the hook (nginx reload) fails halfway, we want state to be
            // "we tried to switch". If we ran the hook first and it succeeded but the state
            // write then failed, state and nginx would diverge silently. State-first keeps
            // a single source of truth; hook failures get logged and notified separately.
            const tmp = projectStatePath + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(projectState, null, 4), "utf-8");
            fs.renameSync(tmp, projectStatePath);

            // Rewrite upstream.conf to point at the new active slot's port. Runs BEFORE the
            // reload hook so nginx reload picks up the fresh port. server.conf is a no-op here
            // (already seeded, devops owns it now). If _renderNginx errors, state is already
            // committed — we log and continue (nginx keeps old upstream, oncall can fix manually).
            let hookError: string | null = null;
            if (found.nginx?.config_dir) {
                // Merge base config with the NEW active slot config to extract its PORT.
                // In switchSlot `found` is the un-mutated original (unlike proceed), so we merge
                // manually here — no side effects on the shared config Map.
                const slotCfg = target === "blue" ? found.bluegreen.blue_config : found.bluegreen.green_config;
                const merged = { ...((found.config ?? {}) as Record<string, string>), ...((slotCfg ?? {}) as Record<string, string>) };
                const nginxErr = await this._renderNginx(found, data.name, DeployerService._extractPort(merged));
                if (nginxErr) {
                    logError("nginx render during switch failed (state already flipped): " + nginxErr.message);
                    hookError = nginxErr.message;
                }
            }

            // Reload nginx (or run any other post-switch command). Non-fatal — state and upstream
            // file are already committed; a failed reload can be retried manually. Hardened path
            // (absolute-only, timeout, minimal env, async) lives inside NginxHelper.runHook.
            if (!hookError) {
                hookError = await NginxHelper.runHook(found.bluegreen.on_switch);
            }

            // Tell both slots now, over their control sockets, instead of at their next poll: crons and
            // queue consumers move to the new live slot within a second. Each slot asks the deployer
            // for the state itself. Best effort: a slot without the channel catches up on its poll.
            const told = await Promise.all((["blue","green"] as const).map(async slot => {
                const sock = controlSocketPath(found.name, slot);
                if(!sock) return null;
                try{ return (await controlCall<{live:boolean|null}>(sock, "refresh-live", undefined, 3000)).live; }
                catch{ return null; }
            }));
            logInfo(`Switch of "${found.name}": slots told — blue ${told[0] ?? "no answer"}, green ${told[1] ?? "no answer"}`);

            const status = hookError ? "switch-hook-failed" : action === "rollback" ? `rolled-back-to-${target}` : `switched-to-${target}`;
            this.telegram(found.name, status, user.login);
            if(found.email && found.email.length > 0){
                for(const email of found.email){
                    this.notifier?.notifyEmailStatus(email, status, found.name, user.login);
                }
            }
            if(found.phone && found.phone.length > 0){
                for(const p of found.phone){
                    this.notifier?.notifySMSStatus(p, `${found.name} ${action} to ${target}`, user.login);
                }
            }

            return {data:{active: projectState.active, previousActive, action, hookError}}
        }finally{
            this.busy.set(realName, false);
        }
    }

    // Read-only snapshot of state for one or all projects. Used by the UI to show
    // "who's in production" and whether there's an un-switched slot waiting.
    async status(data:{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name?:string}){
        const auth = await this._checkUserAuth(data.auth, data.authLogin, data.ip, data.sig);
        const user = auth.user;
        if (!user) {
            return {error:{code:50,message:auth.error ?? "Unauthorized.",httpStatus:auth.status ?? 401}}
        }

        const configurations = await REQ_DEPLOYMENT_CONFIG.request();
        const results: Record<string, {
            hasBlueGreen: boolean,
            state: IProjectState | null,
            readyToSwitch: boolean,
        }> = {};

        for(const cfg of configurations.values()){
            if(data.name && cfg.name !== data.name) continue;

            const statePath = path.resolve(this.options.projects_path, cfg.name + "_state_.json");
            let state: IProjectState | null = null;
            if(fs.existsSync(statePath)){
                try{
                    state = JSON.parse(fs.readFileSync(statePath,"utf-8"));
                }catch{}
            }

            results[cfg.name] = {
                hasBlueGreen: !!(cfg.bluegreen && cfg.bluegreen.blue_config && cfg.bluegreen.green_config),
                state,
                readyToSwitch: !!(state && state.lastDeployed !== state.active),
            };
        }

        return {data: results}
    }

    private static _isBlueGreen(found: IConfig): boolean {
        return !!(found.bluegreen && found.bluegreen.blue_config && found.bluegreen.green_config);
    }

    // Backups sit one level above the directory a deploy overwrites: the slot for blue-green
    // (→ the project root), the destination itself otherwise (→ its parent).
    private static _backupRoot(found: IConfig): string {
        const dest = path.resolve(found.destination);
        return DeployerService._isBlueGreen(found) ? dest : path.dirname(dest);
    }

    // Read-only, like status: deployer user auth is enough, no project token.
    async listBackups(data:{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string}){
        const auth = await this._checkUserAuth(data.auth, data.authLogin, data.ip, data.sig);
        const user = auth.user;
        if (!user) {
            return {error:{code:50,message:auth.error ?? "Unauthorized.",httpStatus:auth.status ?? 401}}
        }

        const configurations = await REQ_DEPLOYMENT_CONFIG.request();
        const found = Array.from(configurations.values()).find(c => c.name === data.name);
        if(!found)
            return {error:{code:58,message:"Project not found.",httpStatus:404}}

        const backups = await BackupManager.list(DeployerService._backupRoot(found), found.name, true);

        // Active slot lets a client warn before restoring straight into production.
        const isBG = DeployerService._isBlueGreen(found);
        let activeSlot: string | null = null;
        if(isBG){
            try{
                const statePath = path.resolve(this.options.projects_path, found.name + "_state_.json");
                activeSlot = JSON.parse(fs.readFileSync(statePath,"utf-8"))?.active ?? null;
            }catch{ activeSlot = null; }
        }

        return {data:{
            project: found.name,
            bluegreen: isBG,
            activeSlot,
            backupEnabled: !!found.backup,
            keep: MAX_BACKUPS,
            backups,
        }}
    }

    // Destructive, like switch: deployer user auth AND the project token, under the deploy lock.
    async restoreBackup(data:{auth?:string,authLogin?:string,ip?:string,sig?:ISignedAuthVerdict,name:string,token:string,backup:string}){
        const auth = await this._checkUserAuth(data.auth, data.authLogin, data.ip, data.sig);
        const user = auth.user;
        if (!user) {
            logError("Restore rejected: user auth failed")
            return {error:{code:50,message:auth.error ?? "Unauthorized.",httpStatus:auth.status ?? 401}}
        }

        const configurations = await REQ_DEPLOYMENT_CONFIG.request();
        const project = await this._projectByToken(configurations, data.name, data.token);
        if(project.error)
            return {error:{code:41,message:project.error,httpStatus:400}}
        let found:IConfig|undefined = project.config;
        if(!found){
            logError("Restore rejected: wrong token and/or name")
            return {error:{code:41,message:"Wrong token and/or name.",httpStatus:400}}
        }
        if(this.busy.get(found.name))
            return {error:{code:43,message:"Deployment in progress, try again shortly.",httpStatus:409}}

        const realName = found.name;
        this.busy.set(realName, true);
        try{
            const root = DeployerService._backupRoot(found);
            const backup = BackupManager.resolve(root, realName, data.backup);
            if(!backup)
                return {error:{code:55,message:"Backup not found.",details:data.backup,httpStatus:404}}

            // The target is derived from the CURRENT config — never from paths stored in the
            // backup, which would let a tampered metadata file redirect the restore anywhere.
            const isBG = DeployerService._isBlueGreen(found);
            const slot = backup.meta.slot;
            if(isBG !== !!slot)
                return {error:{code:57,message:isBG
                    ? "Backup has no slot, but the project is blue-green now."
                    : "Backup belongs to a blue-green slot, but the project is not blue-green now.",httpStatus:400}}
            const target = isBG ? path.join(path.resolve(found.destination), slot as string) : path.resolve(found.destination);

            // Restore swaps the whole directory, so it is held to the same rules as a wiping deploy.
            const targetProblem = this._destinationProblem(target, true, Array.from(configurations.values()),
                isBG ? path.resolve(found.destination) : target);
            if(targetProblem)
                return {error:{code:19,message:"Unsafe destination.",details:targetProblem,httpStatus:400}}

            let state:IProjectState|null = null;
            const statePath = path.resolve(this.options.projects_path, realName + "_state_.json");
            if(isBG && fs.existsSync(statePath)){
                try{ state = JSON.parse(fs.readFileSync(statePath,"utf-8")); }catch{ state = null; }
            }

            // Safety net: what we are about to replace is backed up first, so a wrong restore can
            // itself be undone.
            const preRestore = await BackupManager.create(target, realName, slot, user.login, "pre-restore");
            await BackupManager.restoreInto(backup.dir, target);

            if(isBG && state)
                this._writeBlueGreenFiles(realName, state, path.resolve(found.destination));

            let pm2Error:IError|null = null;
            const runner = this._runnerFor(found, realName);
            if(runner){
                const runFound = { ...structuredClone(found), name: isBG ? `${realName}-${slot}` : realName, destination: target } as IConfig;
                const slotConfig = isBG ? (slot === "blue" ? found.bluegreen?.blue_config : found.bluegreen?.green_config) : null;
                pm2Error = await runner.start(runFound, {
                    name: runFound.name, project: realName, slot: (slot ?? null) as "blue"|"green"|null, destination: target,
                    config: { ...(found.config ?? {}), ...(slotConfig ?? {}) } as Record<string, unknown>,
                }, state ? { ...state, lastDeployed: slot as any } : null);
                if(pm2Error) logError(`Restore: ${runner.kind} restart failed for ${runFound.name}: ${pm2Error.details ?? pm2Error.message}`);
            }

            if(isBG && state){
                state.history.push({ slot: slot as any, action: "restore" as any, user: user.login, at: Date.now() });
                DeployerService._trimHistory(state);
                const tmp = statePath + ".tmp";
                fs.writeFileSync(tmp, JSON.stringify(state, null, 4), "utf-8");
                fs.renameSync(tmp, statePath);
            }

            // Retention runs after the restore; the backup just restored is kept even if oldest.
            await BackupManager.prune(root, realName, MAX_BACKUPS, [data.backup]);

            logInfo(`Restored ${realName}${slot ? "/" + slot : ""} from ${data.backup} by ${user.login}`);
            this.telegram(found.name, pm2Error ? "error-restore-" + (runner?.kind ?? "pm2") : `restored from ${data.backup}`, user.login);
            if(found.email && found.email.length > 0){
                for(let email of found.email)
                    this.notifier?.notifyEmailStatus(email, pm2Error ? "error-restore-" + (runner?.kind ?? "pm2") : "restored", found.name, user.login)
            }

            return {data:{
                project: realName,
                restored: data.backup,
                appVersion: backup.meta.appVersion,
                slot,
                activeSlot: state?.active ?? null,
                // A restored ACTIVE slot is live immediately; an inactive one needs an activate.
                live: !isBG || slot === state?.active,
                preRestoreBackup: preRestore,
                // pm2Restarted / pm2Error keep their names for older CLIs; they cover systemd too.
                runner: runner?.kind ?? "none",
                pm2Restarted: !!runner && !pm2Error,
                pm2Error: pm2Error ? (pm2Error.details ?? pm2Error.message) : null,
            }}
        }catch(e:any){
            logError("Restore failed: " + (e?.message ?? e));
            return {error:{code:56,message:"Restore failed.",details:String(e?.message ?? e),httpStatus:500}}
        }finally{
            this.busy.set(realName, false);
        }
    }

    // Read-only "is this slot live?" query for DEPLOYED APPS (see BlueGreenState.ts). Auth is the
    // per-project statusToken from the slot's .bluegreen.json — no deployer user is involved, so:
    //   - `name` is strictly validated (it becomes part of a file path → no traversal);
    //   - unknown project and wrong token return the SAME 401, so projects can't be enumerated;
    //   - the token comparison runs even when the project is unknown (uniform timing).
    async slotState(data:{name:string,token:string,slot?:"blue"|"green"}){
        const deny = {error:{code:53,message:"Invalid project or status token.",httpStatus:401}};
        if(!data || typeof data.name !== "string" || typeof data.token !== "string" || !/^[A-Za-z0-9._-]+$/.test(data.name))
            return deny;

        let state: IProjectState | null = null;
        try{
            const statePath = path.resolve(this.options.projects_path, data.name + "_state_.json");
            if(fs.existsSync(statePath))
                state = JSON.parse(fs.readFileSync(statePath,"utf-8"));
        }catch{ state = null; }

        const tokenOk = this.tokensMatch(data.token, state?.statusToken || crypto.randomBytes(32).toString("hex"));
        if(!state || !state.statusToken || !tokenOk)
            return deny;

        const slot = data.slot === "blue" || data.slot === "green" ? data.slot : null;
        return {data:{
            project: data.name,
            active: state.active ?? null,
            lastDeployed: state.lastDeployed ?? null,
            readyToSwitch: !!(state.lastDeployed && state.lastDeployed !== state.active),
            slot,
            isActive: slot ? slot === state.active : null,
            checkedAt: Date.now(),
        }};
    }

    // Where deployed apps reach pckg/slot. setup.json `status_url` wins; otherwise loopback on the
    // deployer's own port — the deployer and the apps it deploys always share a host.
    private _statusUrl(): string {
        const override = (this.setup as any)?.status_url;
        if(typeof override === "string" && override.length > 0)
            return override;
        let base = this.options.selfBaseEndPoint ?? "/api/";
        if(!base.startsWith("/")) base = "/" + base;
        if(!base.endsWith("/")) base += "/";
        return `http://127.0.0.1:${this.options.selfPort ?? 8080}${base}pckg/slot`;
    }

    // Write BLUEGREEN_FILE into every existing slot directory of the project. Mode 0600: it holds
    // the status token. Failures are logged, never fatal — the deploy itself must not fail on it.
    private _writeBlueGreenFiles(project: string, state: IProjectState, projectRoot: string){
        if(!state.statusToken) return;
        const statusUrl = this._statusUrl();
        for(const slot of ["blue","green"] as const){
            const dir = path.resolve(projectRoot, slot);
            if(!fs.existsSync(dir)) continue;
            const file = path.resolve(dir, BLUEGREEN_FILE);
            const payload = { version: 1, project, slot, statusUrl, token: state.statusToken, writtenAt: Date.now() };
            try{
                const tmp = file + ".tmp";
                fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
                fs.renameSync(tmp, file);
            }catch(e:any){
                logWarn(`Cannot write ${BLUEGREEN_FILE} for ${project}/${slot}: ${e?.message ?? e}`);
            }
        }
    }

    // Constant-time token comparison. Hashing both sides first sidesteps the
    // length-mismatch throw in timingSafeEqual and avoids leaking token length
    // or matching-prefix length via response timing.

    // Finds the project and checks its token. Runs only after the deployer user was verified, so
    // the scrypt here can't be triggered by anonymous callers. A plain-text token in the config is
    // refused; the explicit reason only reaches a caller who sent that very token.
    private async _projectByToken(configurations:Map<string,IConfig>, name:string, token:string): Promise<{ config?: IConfig, error?: string }> {
        const config = Array.from(configurations.values()).find(c => c.name === name);
        if(!config || typeof token !== "string" || !token)
            return {};
        if(PasswordHash.isHash(config.token))
            return (await PasswordHash.verify(token, config.token)) ? { config } : {};
        if(config.token && this.tokensMatch(config.token, token))
            logError(`Deployer: project "${name}" refused — the right token was sent, but the project config stores it as plain text; store a hash: npx bmfk project-token --hash`);
        return {};
    }

    tokensMatch(a:string|undefined,b:string|undefined):boolean{
        const ha = new Uint8Array(crypto.createHash("sha256").update(String(a ?? "")).digest());
        const hb = new Uint8Array(crypto.createHash("sha256").update(String(b ?? "")).digest());
        return crypto.timingSafeEqual(ha,hb);
    }

    // Checks the incoming Authorization header against configured deployer users.
    // Expected header value: "Bearer <hex>" or bare "<hex>" where hex = sha256(login:password).
    // Returns the matched user (whose login is used in notifications) or null.
    // Walks the entire user list even after a match — constant work regardless of which
    // (or whether any) user matched, so timing doesn't leak which login was hit.
    static buildAllowList(entries: readonly string[] | undefined | null) {
        return IpAllowList.build(entries);
    }

    isIpAllowed(ip: string | undefined): boolean {
        return this._ipAllowed(ip);
    }

    private _ipAllowed(ip: string | undefined): boolean {
        return IpAllowList.allows(IpAllowList.build(this.setup?.allowed_ips).list, ip);
    }

    private _warnPlaintextUsers(){
        if (!DeployerService.buildAllowList(this.setup?.allowed_ips).list)
            logWarn("Deployer: allowed_ips is not set in setup.json — deploys are accepted from any address");
        const users = this.setup?.users ?? [];
        const plain = users.filter(u => u?.login && !u.publicKey && u.password && !PasswordHash.isHash(u.password)).map(u => u.login);
        const keyless = users.filter(u => u?.login && !u.publicKey && !u.password).map(u => u.login);
        if(keyless.length)
            logError(`Deployer: ${keyless.map(l=>'"'+l+'"').join(", ")} in setup.json have neither a password nor a publicKey — they can't sign in`);
        const passwordUsers = users.filter(u => u?.login && !u.publicKey && u.password).map(u => u.login);
        if(this.setup?.require_signature !== false && passwordUsers.length)
            logWarn(`Deployer: only signed requests are accepted — password users ${passwordUsers.map(l=>'"'+l+'"').join(", ")} can't sign in until they get a publicKey (npx bmfk deploy-key), or set "require_signature": false`);
        else if(this.setup?.require_signature === false && passwordUsers.length)
            logWarn(`Deployer: "require_signature": false — ${passwordUsers.length} user(s) sign in with a password; give them a publicKey (npx bmfk deploy-key) and remove the setting`);
        if(plain.length)
            logError(`Deployer: password stored as plain text in setup.json for ${plain.map(l=>'"'+l+'"').join(", ")} — these users are refused; store a hash instead: npx bmfk hash-password --deployer`);
    }


    private async _checkUserAuth(authHeader: string | undefined, loginHeader?: string, ip?: string, sig?: ISignedAuthVerdict): Promise<{ user?: IDeployerUser, error?: string, status?: number }> {
        // Before credentials: a caller from elsewhere learns nothing about them, and costs no scrypt.
        if (!this._ipAllowed(ip)) {
            logWarn(`Deployer: request refused from ${ip ?? "unknown"} — not in allowed_ips`);
            return { error: "Forbidden.", status: 403 };
        }
        // Why a request was refused goes to the server log only — the client always gets the same
        // "Unauthorized". The login comes from the client: cut and stripped so it can't forge log lines.
        const from = ip ?? "unknown";
        const shown = (v: string) => JSON.stringify(v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64));
        const refuse = (reason: string) => { logWarn(`Deployer auth failed from ${from}: ${reason}`); return {}; };

        if(!this.setup) return refuse("setup.json is not loaded");

        // Signed request (checked by the endpoint against the user's public key).
        if (sig?.present) {
            if (sig.error || !sig.kid) return refuse(`signature refused — ${sig.error ?? "no key id"}`);
            const user = (this.setup.users ?? []).find(u => u.login === sig.kid);
            if (!user?.publicKey) return refuse(`signature by ${shown(sig.kid)}, who has no publicKey in setup.json`);
            return { user: user as IDeployerUser };
        }
        if (this.setup.require_signature !== false)
            return refuse("unsigned request — only signed requests are accepted; the client needs a privateKey in deploy.json (npx bmfk deploy-key)");

        if (!authHeader) return refuse("no Authorization header");

        const token = authHeader.split(" ").pop() ?? "";
        if (!token) return refuse("empty Authorization header");
        const users = this.setup.users ?? [];
        if (users.length === 0) return refuse("no users in setup.json");

        // Users keep scrypt(sha256(login:password)) — the wire protocol (Bearer sha256) is
        // unchanged, only what sits in setup.json is. The client must name itself in
        // X-Deployer-Login so at most ONE scrypt runs per request: trying every hashed user would
        // let any unauthenticated caller burn CPU on the host at will.
        const login = typeof loginHeader === "string" ? loginHeader.trim() : "";
        if (login) {
            const user = users.find(u => u.login === login);
            if (!user) return refuse(`unknown login ${shown(login)}`);
            if (user.publicKey) return refuse(`${shown(login)} has a publicKey — only signed requests are accepted for them; the client needs its privateKey in deploy.json`);
            if (!user.password) return refuse(`${shown(login)} has neither a password nor a publicKey in setup.json`);
            if (PasswordHash.isHash(user.password))
                return (await PasswordHash.verify(token, user.password)) ? { user: user as IDeployerUser } : refuse(`wrong password for ${shown(login)} (or the client's login/password differ from setup.json)`);
        }

        // Plain-text users are refused. The explicit reason is only given to a caller holding the
        // right credentials (constant-work walk, no scrypt), so it doesn't reveal which logins exist.
        let plainMatch: string | null = null;
        for (const user of users) {
            if (user.publicKey || !user.password || PasswordHash.isHash(user.password)) continue;
            const expected = crypto.createHash("sha256").update(user.login + ":" + user.password).digest("hex");
            if (this.tokensMatch(token, expected)) plainMatch = user.login;
        }
        if (plainMatch) {
            // Same answer as wrong credentials; the reason is for the operator, in the log.
            logError(`Deployer: "${plainMatch}" sent the right credentials, but setup.json stores the password as plain text — refused; store a hash: npx bmfk hash-password --deployer`);
            return {};
        }
        if (!login)
            return refuse("no X-Deployer-Login header — the client runs an old CLI; update it");
        return refuse(`wrong password for ${shown(login)}`);
    }

    // Two-file nginx integration:
    //   <config_dir>/<name>.upstream.conf — deployer-owned, ALWAYS overwritten with active port
    //   <config_dir>/<name>.server.conf   — seeded once, DEVOPS-owned afterwards (certbot, etc.)
    // Called from proceed on first deploy (initial active) and from switchSlot on every flip.
    // For subsequent deploys of the inactive slot, this MUST NOT be called — otherwise nginx would
    // start pointing at the not-yet-ready inactive port.
    // Extract the port from a merged config, case-insensitively. Users write the key however
    // they template it in their project files (`port`, `PORT`, `Port` all work in applyConfig),
    // so nginx rendering must be just as forgiving — otherwise a `port`/`PORT` mismatch means
    // the app starts fine (applyConfig matched) but nginx render fails with a confusing "no PORT".
    private static _extractPort(config: Record<string, any> | undefined | null): string {
        if (!config || typeof config !== "object") return "";
        for (const key of Object.keys(config)) {
            if (key.toLowerCase() === "port") {
                const v = config[key];
                if (v !== null && v !== undefined && String(v).length > 0) return String(v);
            }
        }
        return "";
    }

    private async _renderNginx(found: IConfig, projectName: string, activePort: string): Promise<IError | null> {
        if (!found.nginx?.config_dir) return null;
        if (!activePort) {
            return { code: 52, message: "Cannot render nginx: no port found in config for project " + projectName + " (expected a 'port' key in config or blue_config/green_config)", httpStatus: 500 };
        }

        const dir = found.nginx.config_dir;
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e: any) {
            return { code: 50, message: "Cannot create nginx config_dir: " + String(e?.message ?? e), httpStatus: 500 };
        }

        // Nginx upstream names accept most chars, but sanitize to `[a-zA-Z0-9_]` for safety.
        // Project names may contain `.` and `-` (allowed by checkName), which nginx tolerates but
        // some tooling doesn't; underscore is universally safe.
        const safeName = projectName.replace(/[^a-zA-Z0-9_]/g, "_");
        const upstreamName = found.nginx.upstream_name || (safeName + "_backend");
        const upstreamPath = path.resolve(dir, projectName + ".upstream.conf");
        const serverPath = path.resolve(dir, projectName + ".server.conf");

        // Seed server.conf ONCE. If devops has already customized it (added certbot SSL, extra
        // locations), we don't touch it. The values here are used only at seed time — the seeded
        // file becomes devops property from that point on.
        // Domain lives under `nginx.domain` (nginx-level concern), not in the shared `config` block.
        // If unset, we fall back to the project name and warn — server.conf will be seeded with a
        // garbage server_name, operator should fix it or delete the file to re-seed.
        const domain = found.nginx.domain || projectName;
        if (!found.nginx.domain) {
            logWarn("nginx.domain not set for project " + projectName +
                    " — seeding server.conf with server_name=" + projectName + " (edit or delete .server.conf to fix)");
        }
        const seedResult = NginxHelper.seedServerConfig(serverPath, DEFAULT_SERVER_TEMPLATE, {
            DOMAIN: domain,
            UPSTREAM: upstreamName,
        });
        if (seedResult.error) return seedResult.error;
        if (seedResult.seeded) {
            logWarn("Seeded nginx server config for " + projectName + " at " + serverPath +
                    " — run `certbot --nginx -d " + domain + "` to add SSL");
        }

        // ALWAYS rewrite upstream.conf with the current active port. Tiny file, deployer-owned.
        const upstreamErr = NginxHelper.writeUpstream(upstreamPath, upstreamName, activePort);
        if (upstreamErr) return upstreamErr;

        return null;
    }

    // Dirs we never descend into: they hold thousands of files, can't legitimately contain
    // deployer templates, and iterating them wastes minutes on every deploy.
    private static readonly SKIP_DIRS = new Set(["node_modules", ".git", "__tmp"]);

    // Files eligible for `_{{KEY}}_` substitution. `.html` intentionally excluded — HTML
    // is user-facing, unescaped substitution here is an XSS vector. If a project genuinely
    // needs HTML templating, add an explicit per-config allowlist later.
    private static readonly TEMPLATE_EXTENSIONS = [".js", ".ts", ".json", ".env"];

    async applyConfig(dir:string,config:Record<string,string>,ctx?:{ secretsFile: string|null, onDisk: string[] }){
        if(Object.keys(config).length<1)
            return;
        const entries = fs.readdirSync(dir,{withFileTypes:true})
        for(const entry of entries){
            // Symlinks: skip. Avoids following links out of the destination tree and prevents
            // infinite recursion on cyclic links.
            if(entry.isSymbolicLink()) continue;

            if(entry.isDirectory()){
                if(DeployerService.SKIP_DIRS.has(entry.name)) continue;
                const fullPath = path.join(dir,entry.name)
                await this.applyConfig(fullPath,config,ctx)
                continue;
            }

            if(entry.isFile()){
                const fullPath = path.join(dir,entry.name)
                const lower = fullPath.toLowerCase();
                if (DeployerService.TEMPLATE_EXTENSIONS.some(ext => lower.endsWith(ext)))
                    await this.processFile(fullPath,config,ctx)
            }
        }
    }

    async processFile(filePath:string,config:Record<string,string>,ctx?:{ secretsFile: string|null, onDisk: string[] }){
        let content = fs.readFileSync(filePath,"utf-8");
        let hash = crypto.createHash("md5").update(content).digest("hex");

        // Secrets mode: quoted placeholders in CommonJS files read the secrets file instead of
        // holding the value. Kept only if the file still compiles (it is never run here).
        const lowerPath = filePath.toLowerCase();
        if(ctx?.secretsFile && (lowerPath.endsWith(".js") || lowerPath.endsWith(".cjs")) && content.includes("_{{")){
            const t = SecretsInjector.transform(content, new Set(Object.keys(config)), ctx.secretsFile);
            if(t.rewritten > 0){
                const noShebang = (src:string) => src.replace(/^#!.*/, "");
                if(SecretsInjector.parses(noShebang(content)) && SecretsInjector.parses(noShebang(t.content)))
                    content = t.content;
                else
                    logWarn(`Secrets: ${filePath} can't be rewritten safely (it doesn't compile as CommonJS) — values are substituted as before`);
            }
        }

        let substituted = false;
        for(const [key,value] of Object.entries(config)){
            const placeholder = `_{{${key}}}_`;
            if(content.includes(placeholder)){
                // Secrets mode: a value written into the code would also land in every backup.
                if(ctx?.secretsFile)
                    throw {code:68,message:"A config value would be written into the code — the app was not started.",
                        details:`${filePath}: _{{${key}}}_ is not a quoted placeholder in a CommonJS .js/.cjs file, so it can't read the secrets file`,httpStatus:500}
                substituted = true;
                content=content.replaceAll(placeholder,()=>String(value))
            }
        }
        if(substituted && ctx?.secretsFile !== undefined && ctx.onDisk) ctx.onDisk.push(filePath);
        let hash2 = crypto.createHash("md5").update(content).digest("hex");
        if(hash!==hash2){
            logInfo("Values was changed in "+filePath)
            fs.writeFileSync(filePath,content,"utf-8")
        }

        // Warn on unresolved placeholders — usually means the deployer config is missing a key.
        // Catches silent misconfigurations before the running app hits the literal "_{{KEY}}_".
        const leftover = content.match(/_\{\{[A-Za-z0-9_]+\}\}_/g);
        if(leftover && leftover.length > 0){
            const unique = [...new Set(leftover)];
            logWarn("Unresolved template placeholders in "+filePath+": "+unique.join(", "));
        }
    }


    // Refuses to touch anything outside projects_path. Called before every destructive
    // step (rm/cp) so a misconfigured or malicious `destination` can't nuke the host.
    // Why a destination is unsafe to deploy/restore into, or null. Replaces the old check that
    // required destinations to live under projects_path — that is the deployer's CONFIG folder,
    // real projects live elsewhere (/var/node/<project>), so it rejected every deploy.
    //   dir          — the directory that gets written (the slot for blue-green)
    //   willClean    — whether its contents are wiped first (!ignoreDirectoryClean)
    //   ownDest      — this project's configured destination, so it isn't compared with itself
    private _destinationProblem(dir: string, willClean: boolean, configs: IConfig[], ownDest: string): string | null {
        if (typeof dir !== "string" || !path.isAbsolute(dir)) return "destination must be an absolute path";
        const dest = path.resolve(dir);
        if (dest === path.parse(dest).root) return "destination is the filesystem root";
        // "/var", "/etc", "/home", "/usr", "/opt", "/srv"… — a project needs its own folder below them.
        if (dest.split(path.sep).filter(Boolean).length < 2)
            return `destination "${dest}" is a top-level system directory`;

        const covers = (outer: string, inner: string) => inner === outer || inner.startsWith(outer + path.sep);
        const configsDir = path.resolve(this.options.projects_path);
        if (covers(dest, configsDir)) return `destination "${dest}" contains the deployer's config folder`;
        if (covers(dest, path.resolve(process.cwd()))) return `destination "${dest}" contains the deployer itself`;

        // Wiping a folder that holds another project would delete that project. With
        // ignoreDirectoryClean nothing is wiped, so nested layouts keep working.
        if (willClean) {
            const own = path.resolve(ownDest);
            for (const c of configs) {
                if (!c?.destination) continue;
                const other = path.resolve(c.destination);
                if (other === own) continue;
                if (other !== dest && covers(dest, other))
                    return `destination "${dest}" contains project "${c.name}" (${other}) and would be wiped`;
            }
        }
        return null;
    }

    // First archive entry that is absolute or climbs out with "..", or null. `tar -tzf` lists plain
    // names in the same format for GNU tar and bsdtar.
    private static _unsafeArchiveEntry(archive: string): string | null {
        let listing = "";
        try { listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }); }
        catch (e: any) { return "archive cannot be listed: " + (e?.message ?? e); }
        for (const raw of listing.split("\n")) {
            const name = raw.trim();
            if (!name) continue;
            if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) return name;
            if (name.split(/[\\/]/).includes("..")) return name;
        }
        return null;
    }

    // First symlink under root whose target is absolute or resolves outside root, or null.
    // Symlinked directories are not followed, so a link cannot cause a loop.
    private static _escapingSymlink(root: string): string | null {
        const base = path.resolve(root);
        const stack = [base];
        while (stack.length) {
            const dir = stack.pop() as string;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isSymbolicLink()) {
                    const target = fs.readlinkSync(p);
                    const resolved = path.resolve(dir, target);
                    if (path.isAbsolute(target) || (resolved !== base && !resolved.startsWith(base + path.sep)))
                        return `${path.relative(base, p)} -> ${target}`;
                } else if (e.isDirectory()) {
                    stack.push(p);
                }
            }
        }
        return null;
    }

    // `npm run migrate` inside the deployed directory. cwd is the project, so a migration that
    // loads .env with dotenv finds the file the deployer has just filled in. Output goes to the log
    // and, on failure, back to the deploy client — sanitized, since connection errors love to
    // print DSNs with passwords in them.
    private async _runMigrate(dir: string): Promise<IError | null> {
        const tail = (t: string) => {
            const s = LogService.sanitize(String(t ?? "").trim());
            return s.length > 4000 ? "…" + s.slice(-4000) : s;
        };

        let scripts: any = null;
        try { scripts = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"))?.scripts; } catch {}
        if (!scripts || typeof scripts.migrate !== "string")
            return {code:60,message:'"migrate" is enabled, but package.json has no "migrate" script.',httpStatus:500};

        logInfo(`Running migrations: npm run migrate (${scripts.migrate})`);
        try {
            const { stdout, stderr } = await execFileAsync("npm", ["run", "migrate"],
                { cwd: dir, timeout: DeployerService.MIGRATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
            logInfo("Migrations finished:\n" + tail(String(stdout) + String(stderr)));
            return null;
        } catch (e: any) {
            const out = tail(String(e?.stdout ?? "") + String(e?.stderr ?? ""));
            const reason = e?.killed ? `timed out after ${DeployerService.MIGRATE_TIMEOUT_MS / 60000} min` : `exit code ${e?.code}`;
            logError(`Migrations failed (${reason}):\n${out}`);
            return {code:60,message:`Migrations failed (${reason}), the process was not restarted.`,details:out,httpStatus:500};
        }
    }

    static MIGRATE_TIMEOUT_MS = 10 * 60 * 1000;

    // The deployer's project name is the app's name on the server: written into the deployed
    // package.json (and its lock), it names the app's data folder ~/.bmfk/<name>. One source tree
    // can be deployed as several projects — each copy gets its own name. Never fails a deploy.
    static _stampProjectName(dir:string, projectName:string){
        const problem = projectNameProblem(projectName);
        if(problem){
            logWarn(`${problem} — package.json "name" left as it is`);
            return;
        }
        for(const file of ["package.json","package-lock.json"]){
            const p = path.resolve(dir,file);
            if(!fs.existsSync(p)) continue;
            try{
                const text = fs.readFileSync(p,"utf-8");
                const doc = JSON.parse(text);
                let changed = false;
                if(doc.name !== projectName){ doc.name = projectName; changed = true; }
                if(file === "package-lock.json" && doc.packages?.[""] && doc.packages[""].name !== projectName){
                    doc.packages[""].name = projectName; changed = true;
                }
                if(!changed) continue;
                const indent = /^\{\n(\t| +)/.exec(text)?.[1] ?? "\t";
                fs.writeFileSync(p, JSON.stringify(doc,null,indent) + "\n");
            }catch(e:any){
                logWarn(`Cannot set the project name in ${file}: ${e?.message ?? e}`);
            }
        }
    }

    async unpack(destination:string,uploadedFile:string,install?:boolean,ignoreDirectoryClean?:boolean,omitDev?:boolean,projectName?:string):Promise<IError|null>{

        return new Promise((resolve)=>{
            // The destination itself is validated earlier, in proceed()/restoreBackup(), against the
            // real layout (see _destinationProblem).

            // Nothing in the archive may land outside the slot. Checked here, tar-independently:
            // `--no-absolute-names` is not understood by every tar (bsdtar rejects it and the whole
            // extraction fails), and both GNU tar and bsdtar already strip "/" and refuse ".." by
            // default — so we verify the listing ourselves instead of relying on a flag.
            const unsafeEntry = DeployerService._unsafeArchiveEntry(uploadedFile);
            if(unsafeEntry){
                logError("Refusing to unpack: archive entry escapes the destination: " + unsafeEntry);
                try{fs.rmSync(path.resolve(uploadedFile));}catch(e){}
                resolve({code:59,message:"Archive rejected: an entry points outside the destination.",details:unsafeEntry,httpStatus:400});
                return;
            }

            try{
                const tmp = path.resolve(destination,"__tmp")
                if(fs.existsSync(tmp))
                    fs.rmSync(tmp,{recursive:true});
                if(!fs.existsSync(tmp))
                    fs.mkdirSync(tmp,{recursive:true});
                execFileSync("tar", ["-xzf", uploadedFile, "-C", tmp]);
            }catch(e){
                logError(e)
                try{fs.rmSync(path.resolve(uploadedFile));}catch(e){}
                resolve({code:14,message:"Can't unpack file",httpStatus:500})
                return;
            }

            try{fs.rmSync(path.resolve(uploadedFile));}catch(e){
                logError("Can't remove file",e)
            }

            // A symlink is the other way out: "bin -> /etc" passes the name check, then gets copied
            // into the slot as a link pointing at the system. Links must stay inside the archive.
            const escaping = DeployerService._escapingSymlink(path.resolve(destination,"__tmp"));
            if(escaping){
                logError("Refusing to deploy: symlink points outside the archive: " + escaping);
                try{fs.rmSync(path.resolve(destination,"__tmp"),{recursive:true});}catch(e){}
                resolve({code:59,message:"Archive rejected: a symlink points outside the destination.",details:escaping,httpStatus:400});
                return;
            }

            if(projectName)
                DeployerService._stampProjectName(path.resolve(destination,"__tmp"), projectName);

            if(install){
                try{
                    // Prefer `npm ci` when a package-lock.json is present — it installs EXACTLY
                    // what's in the lockfile (deterministic, faster, no lockfile drift). Falls
                    // back to `npm i` if no lockfile exists (older projects, minimal packages).
                    // --ignore-scripts prevents malicious pre/postinstall from running with server
                    // privileges. Build steps that need scripts should be baked into the tarball
                    // before upload.
                    const tmpDir = path.resolve(destination, "__tmp");
                    const useCi = fs.existsSync(path.resolve(tmpDir, "package-lock.json"));
                    if (!useCi) {
                        // Loud on purpose. Without a lockfile the install is non-deterministic
                        // (npm resolves per-package.json ranges fresh each deploy) and exposed to
                        // supply-chain risk (a bad version published between deploys lands
                        // silently). Operator should ship a package-lock.json ASAP.
                        logWarn("No package-lock.json in uploaded tarball — falling back to `npm i`. " +
                                "This is non-deterministic and vulnerable to supply-chain attacks. " +
                                "Commit and include package-lock.json for `npm ci` (deterministic + faster).");
                    }
                    const npmCmd = useCi ? "ci" : "i";
                    // omitDev: the project config asks for production dependencies only.
                    execFileSync("npm", ["--prefix", tmpDir, npmCmd, "--ignore-scripts", ...(omitDev ? ["--omit=dev"] : [])])
                }catch(e){
                    logError(e)
                    logError(e)
                    resolve({code:17,message:"Can't install",httpStatus:500})
                    return;
                }
            }



            // clear directory
            if(!ignoreDirectoryClean){
                fs.readdirSync(destination).forEach((file)=>{
                    if(file === "__tmp")
                        return;
                    try{
                        fs.rmSync(path.resolve(destination,file),{recursive:true});
                    }catch(e){
                        logError(e)
                    }
                })
            }

            // copy from tmp to dir. -P copies symlinks as symlinks: BSD/macOS `cp -r` follows them,
            // so a dangling link failed the copy halfway. No -a/-p on purpose — under root that would
            // carry the archive's (developer machine's) owners into the destination.
            try{
                execFileSync("cp", ["-RPf", path.resolve(destination,"__tmp")+"/.", destination]);
            }catch(e){
                logError(e)
                try{fs.rmSync(path.resolve(destination,"__tmp"),{recursive:true,force:true});}catch(_){}
                resolve({code:15,message:"Can't copy files",httpStatus:500})
                return;
            }

            // remove tmp
            try{
                fs.rmSync(path.resolve(destination,"__tmp"),{recursive:true});
            }catch(e){
                logError(e)
                resolve({code:16,message:"Can't remove tmp",httpStatus:500})
            }

            resolve(null)
        })
    }

    async upload(file:UploadedFile,uploadPath:string):Promise<IError|null>{
        return new Promise((resolve)=>{
            file.mv(uploadPath, (err:any)=>{
                if (err) {
                    resolve({code:13,message:"Can't upload file",httpStatus:500,details:err})
                    return;
                }
                resolve(null)
            });
        })
    }

}