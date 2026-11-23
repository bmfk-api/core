
import fs from "fs"
import path from "path";
import crypto from "crypto";
import { Signal, Req } from "../../signal/Signal";
import { BaseService } from "../BaseService";
import { Validator, ValidationModel } from "../helper/Validator";
import { logError, logWarn } from "../LogService";
import DefaultErrors from "../structures/DefaultErrors";
import { PasswordHash } from "../helper/PasswordHash";

//["--cron-restart", "10 0 * * *"]

const _ProjectState = {
    active:"",
    $__active_values:["blue","green"],        // текущий боевой; null = ни один ещё не активирован


    lastDeployed:"",
    $__lastDeployed_values:["blue","green"],  // куда последний раз выложили, но ещё не переключили

    history: [{
        slot: "",
        $__slot_values:["blue","green"] as const,
        action:"",
        $__action_values:["deploy","switch","rollback","restore"] as const,
        user: "",
        at: 0,
    }],

    // Read-only token the deployed app uses to ask "is my slot the active one?" via pckg/slot.
    // Generated once and reused across deploys so BOTH slots hold a valid token. Grants nothing
    // but reading this project's active slot — never the deploy token or deployer credentials.
    statusToken:"",
    $__statusToken_optional:true,

} as const;

export type IProjectState = ValidationModel<typeof _ProjectState>


const _TConfig={
    name:"",
    destination:"",
    description:"",
    token:"",
    unpack:true,
    
    ignoreDirectoryClean:false,
    backup:true,

    install:true,
    // Install without devDependencies (`npm ci --omit=dev`): no compilers, test tools or bundlers on
    // the server. Off by default — turn it on once `npm start` and `npm run migrate` need nothing
    // from devDependencies.
    omitDev:false,
    $__omitDev_optional:true,
    // Run `npm run migrate` in the destination after unpack and config substitution, before the
    // process is (re)started. Optional, off by default.
    migrate:false,
    $__migrate_optional:true,
    pm2:true,
    pm2_attributes:[""],
    $__pm2_attributes_optional:true,
    chmod:0,
    $__chmod_optional:true,
    email:[""],
    $__email_optional:true,
    phone:[""],
    $__phone_optional:true,
    liveness:"",
    $__liveness_optional:true,
    readiness:"",
    $__readiness_optional:true,
    config:{},
    
    bluegreen:{
        blue_config:{},
        blue_pm2_attributes: [""],   // например разные --instances
        $__blue_pm2_attributes_optional:true,

        green_config:{},
        green_pm2_attributes: [""],
        $__green_pm2_attributes_optional:true,

        on_switch: [""],              // shell-команда после флипа: ["nginx", "-s", "reload"]
        $__on_switch_optional:true,
    },
    $__bluegreen_optional:true,

    nginx:{
        // Directory where per-project nginx configs live. Deployer auto-creates on first deploy.
        // Two files per project are written here:
        //   <name>.upstream.conf — DEPLOYER-owned, overwritten on every activate (port lives here)
        //   <name>.server.conf   — SEEDED once, DEVOPS-owned afterwards (SSL from certbot, etc.)
        // Nginx should `include /path/*.conf` from this dir.
        config_dir: "",
        $__config_dir_optional: true,

        // Public domain — becomes `server_name` in the seeded server.conf and is passed to certbot.
        // Nginx-level concern (unlike application config), so it lives here rather than in
        // the shared `config` block. Used only at seed time — after that, devops owns server.conf
        // and can change domain there directly (deployer never rewrites it).
        domain: "",
        $__domain_optional: true,

        // Nginx upstream block name. Must match what devops writes in `proxy_pass http://NAME;`
        // inside <name>.server.conf. If omitted, defaults to "<project_name>_backend".
        upstream_name: "",
        $__upstream_name_optional: true,
    },
    $__nginx_optional:true,

    // Deploys wait for approval: the archive is held and each reviewer (defined in the deployer's
    // setup.json) gets a link by email. "any" — one accept is enough; "all" — everyone must accept.
    // One decline rejects the deploy. A new upload replaces the pending one and voids old links.
    review:{
        reviewers:[""],
        mode:"",
        $__mode_values:["any","all"],
        ttlHours:24,
        $__ttlHours_optional:true,
    },
    $__review_optional:true,

    // Keep config values out of the deployed code: they go to a secrets file outside the deploy
    // folder ({dir} → <dir>/<project>[-<slot>].json, or {file}; {} uses secrets_dir from the
    // deployer's setup.json, or /var/bmfk/<project>/secrets[-<slot>].json when that is unset), and
    // quoted "_{{KEY}}_" in .js files become a read of that file.
    secrets:{
        dir:"",
        $__dir_optional:true,
        file:"",
        $__file_optional:true,
    },
    $__secrets_optional:true,

} as const;

export type IConfig = ValidationModel<typeof _TConfig>

// The project name ends up in a package.json "name", in /var/bmfk/<name>, in state, backup and
// secrets file names — so it must be valid as all of them: an npm package name that is also a plain
// folder name. Lowercase letters, digits, ".", "_", "-"; starts with a letter or digit; up to 100.
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export function projectNameProblem(name: unknown): string | null {
    if (typeof name !== "string" || name.length === 0) return "the project has no \"name\"";
    if (!PROJECT_NAME.test(name))
        return `project name "${name}" is not allowed — lowercase letters, digits, ".", "_" and "-" only, starting with a letter or digit, up to 100 characters (e.g. "api.gateway.example.com")`;
    return null;
}
// The project config schema, for tools that build or check configs (e.g. `bmfk project-config`).
export const PROJECT_CONFIG_MODEL = _TConfig;

export const REQ_DEPLOYMENT_CONFIG = new Req<void,Map<string,IConfig>>()
export const S_CONFIG_UPDATED = new Signal<void>();

export class ConfigService extends BaseService{

    private configurations:Map<string,IConfig> = new Map();
    private dir: string;
    private busy = false;
    private retake = false;
    private reportedNames = new Set<string>();
    private watchDebounceTimer: NodeJS.Timeout | null = null;
    // MD5 of the last-loaded configurations map. Used to suppress "Configurations updated" log
    // spam from the 60s safety-polling — we only log/emit S_CONFIG_UPDATED when the on-disk
    // content actually changed, not on every idle re-scan.
    private _lastConfigHash: string | null = null;

    constructor(dir:string){
        super("ConfigService");
        this.dir = dir;
    }

    async init(){
        super.init();

        REQ_DEPLOYMENT_CONFIG.listener = async (req)=>this.configurations;

        if(!fs.existsSync(this.dir))
            fs.mkdirSync(this.dir,{recursive:true});

        this.getConfig();

        // fs.watch is notoriously chatty: editors that write via tmp+rename fire multiple events
        // per save, and platforms differ. Debounce collapses that burst into a single rescan.
        fs.watch(this.dir, (_eventType, filename) => {
            if(!filename || !filename.endsWith(".json")) return;
            if(this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
            this.watchDebounceTimer = setTimeout(() => {
                this.watchDebounceTimer = null;
                this.getConfig();
            }, 200);
        });

        // Safety net: fs.watch handles can go silently dead (dir rm+mkdir on Linux drops the
        // inotify watch, atomic replaces can detach it on some platforms). A cheap periodic
        // rescan catches those. unref'd so it doesn't keep the process alive on its own.
        setInterval(() => this.getConfig(), 60_000).unref();
    }

    getConfig(){
        if(this.busy){
            this.retake=true;
            return;
        }
        this.retake=false;
        this.busy=true;
        const temp = new Map();
        let isError=false;
        try{
            const files = fs.readdirSync(this.dir);
            for(let f of files){
                if(f.indexOf(".json") === -1)
                    continue;
                try{
                    const file = fs.readFileSync(path.resolve(this.dir,f));
                    const config = JSON.parse(file.toString());
                    // Not a project config: the deployer's own <name>_state_.json, or setup.json
                    // when setup_path is this folder.
                    if(config?.name === undefined)
                        continue;
                    // A bad name is refused here, so no operation (deploy, switch, restore) can see it.
                    // Said once per file and name, not at every rescan.
                    const nameProblem = projectNameProblem(config.name);
                    if(nameProblem){
                        const key = f + "\0" + String(config.name);
                        if(!this.reportedNames.has(key)){
                            this.reportedNames.add(key);
                            logError(`Deployer: ${f} ignored — ${nameProblem}`);
                        }
                        continue;
                    }
                    temp.set(config.name,config);
                }catch(e){
                    isError=true;
                    logError("Can't read config file: " + f,e)
                }
            }
            if(!isError){
                // Hash the loaded set to detect real changes. The 60s safety-polling calls this
                // method every minute; without this gate we'd log "Configurations updated" and
                // fire S_CONFIG_UPDATED to Watchdog once a minute forever.
                // Note: Map -> Array.from(entries()) because Map doesn't serialize as JSON.
                const hash = crypto.createHash("md5")
                    .update(JSON.stringify(Array.from(temp.entries())))
                    .digest("hex");
                if (hash !== this._lastConfigHash) {
                    this._lastConfigHash = hash;
                    this.configurations = temp;
                    S_CONFIG_UPDATED.invoke()
                    logWarn("Configurations updated")
                    const plain = Array.from(temp.values()).filter((c:any)=>c?.name && !PasswordHash.isHash(c.token)).map((c:any)=>c.name);
                    if(plain.length)
                        logError(`Deployer: project token stored as plain text for ${plain.map(n=>'"'+n+'"').join(", ")} — these projects can't be deployed; store a hash instead: npx bmfk project-token --hash`);
                }
            }
        }catch(e){
            logError("Can't read config directory",e)
        }
        this.busy=false;
        if(this.retake){
            this.retake=false;
            this.getConfig();
        }
    }

}