
export interface IBaseService {
  init: () => Promise<void>
  applicationReady: () => void
  getName: () => string
}

// Watch for process termination
const finalize:(()=>Promise<void>)[]=[]

// interrupt (ctrl-c)
process.on('SIGINT', async () => {
  await Promise.all(finalize.map(f=>f()));
  process.exit(0);
});
            
// terminate (kill)
process.on('SIGTERM',async () => {
  await Promise.all(finalize.map(f=>f()));
  process.exit(0);
});


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

 