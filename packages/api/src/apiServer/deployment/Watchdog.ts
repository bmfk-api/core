import { Http } from "../http/Http";
import { BaseService } from "../BaseService";
import { IConfig, REQ_DEPLOYMENT_CONFIG, S_CONFIG_UPDATED } from "./ConfigService";
import { IDeploymentNotifier } from "./Notifier";
import { listUnits } from "./SystemdUnit";
import { unitStates } from "./Ps";
import { realSystemctl } from "./SystemdRunner";
import { UnitWatch } from "./UnitWatch";
import { logWarn } from "../LogService";

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

        // Processes under systemd: crash, crash-loop and recovery alerts (see UnitWatch.ts).
        if(process.platform === "linux"){
            const watch = new UnitWatch();
            let busy = false, reported = false;
            setInterval(async () => {
                if(busy) return;
                busy = true;
                try{
                    const units = listUnits();
                    if(!units.length) return;
                    const byUnit = new Map(units.map(u => [u.unit, u]));
                    for(const ev of watch.next(await unitStates(realSystemctl, units))){
                        const u = byUnit.get(ev.unit);
                        if(!u) continue;
                        logWarn(`Watchdog: ${u.name} — ${ev.text}`);
                        this.onStatus(u.name, ev.text);
                        const cfg = u.project ? this.config.get(u.project) : undefined;
                        for(const email of cfg?.email ?? [])
                            if(email) this.notifier?.notifyEmailStatus(email, ev.text, u.name, "watchdog");
                    }
                    reported = false;
                }catch(e:any){
                    // Said once until it works again, not every 10 s.
                    if(!reported) logWarn(`Watchdog: can't read the systemd units — ${String(e?.stderr || e?.message || e).trim()}`);
                    reported = true;
                }finally{ busy = false; }
            }, 10000).unref();
        }
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