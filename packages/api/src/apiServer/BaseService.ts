
export interface IBaseService {
  init: () => Promise<void>
  applicationReady: () => void
  getName: () => string
}

// Watch for process termination (SIGTERM from systemd or a deploy, SIGINT from pm2 or Ctrl+C):
//   1. drain — stop taking requests and let the ones in progress finish (APIService);
//   2. finalize — every service's finishService (save state, close pools), all at once;
//   3. exit.
// Services close only after the requests that may still use them are done. A second signal while
// stopping exits at once.
const finalize:(()=>Promise<void>)[]=[]
const drain:(()=>Promise<void>)[]=[]

/** Run before the services are finalized on SIGTERM/SIGINT. */
export function onDrain(fn:()=>Promise<void>){ drain.push(fn); }

let stopping=false;
async function shutdown(){
  if(stopping) process.exit(0);
  stopping=true;
  await Promise.all(drain.map(f=>f().catch(()=>{})));
  await Promise.all(finalize.map(f=>f()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


// Base service
export class BaseService implements IBaseService {

  // Registry of every instantiated service — used by the monitor's inventory endpoint
  // to list what's actually alive in this process. Passive; instances stay for the lifetime
  // of the process (services aren't torn down individually).
  static allInstances: BaseService[] = [];

  protected name: string = "BaseService"

  // Lifecycle markers exposed to the monitor
  createdAt: number = Date.now();
  initializedAt: number | null = null;
  applicationReadyAt: number | null = null;

  constructor (name: string) {
    this.name = name
    this.finishService = this.finishService.bind(this);
    BaseService.allInstances.push(this);
  }

  async init (): Promise<void> {
    console.log("Service: "+this.name+" initialized");
    finalize.push(this.finishService);
    this.initializedAt = Date.now();
  }

  async finishService (){
    console.log("finishService -> "+(this.name ?? "no-name"));
  }

  getName():string{
    return this.name;
  }

  applicationReady (): void {
    this.applicationReadyAt = Date.now();
  }
}

 