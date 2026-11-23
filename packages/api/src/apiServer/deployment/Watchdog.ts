import { Http } from "../http/Http";
import { BaseService } from "../BaseService";
import { IConfig, REQ_DEPLOYMENT_CONFIG, S_CONFIG_UPDATED } from "./ConfigService";
import { IDeploymentNotifier } from "./Notifier";

export class Watchdog extends BaseService {

    config:Map<string,IConfig> = new Map();
    lastStatuses:Map<string,boolean> = new Map();
    notifier:IDeploymentNotifier | null = null;
    // Other channels (Telegram), called once per transition.
    private onStatus: (project:string, status:string)=>void;

    constructor(notifier?:IDeploymentNotifier|null, onStatus?:(project:string, status:string)=>void){
        super("Watchdog")
        this.notifier = notifier || null;
        this.onStatus = onStatus ?? (()=>{});
    }

    applicationReady(): void {
       this.setup();
       S_CONFIG_UPDATED.subscribe(async ()=>{this.config = await REQ_DEPLOYMENT_CONFIG.request()})
    }

    async setup(){
        this.config = await REQ_DEPLOYMENT_CONFIG.request();

        setInterval(() => {
            for(let i of this.config){
                if(i[1].readiness){
                    this.checkReadiness(i[1]);
                }
            }
        }, 10000)
    }


    async checkReadiness(config:IConfig){
        if(!config.readiness)
            return;
        const resp = await Http.get(config.readiness, { retry: { enabled: true } })
        if(resp.ok){
            this.statusPassed(config)
        }else {
            this.statusFailed(config)
        }
    }

    statusPassed(config:IConfig){
        // Only notify on recovery (false → true). First-ever passing check (undefined → true)
        // is silent — we don't want a "readiness-ok" mail on every process restart.
        if(this.lastStatuses.get(config.name) === false){
            this.onStatus(config.name, "readiness-ok");
            if(config.email && config.email.length > 0){
                for(let email of config.email){
                    this.notifier?.notifyEmailStatus(email,"readiness-ok",config.name,"watchdog")
                }
            }
        }
        this.lastStatuses.set(config.name,true)
    }

    statusFailed(config:IConfig){
        // Notify on ANY transition into failure: both true → false (regression) and
        // undefined → false (service was already down when the watchdog started).
        // Previously the first failure was silent, so a service that was down at boot
        // never triggered an alert until it recovered and failed again.
        if(this.lastStatuses.get(config.name) !== false){
            this.onStatus(config.name, "readiness-error");
            if(config.email && config.email.length > 0){
                for(let email of config.email){
                    this.notifier?.notifyEmailStatus(email,"readiness-error",config.name,"watchdog")
                }
            }
        }
        this.lastStatuses.set(config.name,false)
    }
}