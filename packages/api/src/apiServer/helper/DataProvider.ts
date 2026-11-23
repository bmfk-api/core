import { Signal } from "../../signal/Signal";

/**
 * DataProvider 
 * gathering data throught executor and handle duplicate requests
 */
export class DataProvider<T>{
    private static nextID=1;
    private name?:string;
    private busy=false;
    private lastRequestTime=0;
    private cacheTime=1000*60*5
    private data:T|undefined|null;
    private callbacks=new Signal<any>()
    private wasError:boolean=false;

    private executor:()=>Promise<{data:T|null|undefined,error?:boolean}>

    /**
     * 
     * @param executor Execute procedure stored in executor, when need to get data
     * @param cacheTime cache interval
     * @param name DataProvider name (debugging)
     */
    constructor(executor:()=>Promise<{data:T|null|undefined,error?:boolean}>,cacheTime?:number,name?:string){
        this.executor=executor;
        if(cacheTime!==undefined)
            this.cacheTime=+cacheTime;
        if(isNaN(this.cacheTime))
            this.cacheTime=0;
        this.name = name ?? "DataProvider "+(DataProvider.nextID++)
    }

    async forceUpdate(){
        if(this.busy)
            return;
        this.wasError=false;
        this.lastRequestTime=0;
        await this.getData()
    }

    localUpdate(data:T){
        if(this.busy)
            return;
        this.wasError=false;
        this.lastRequestTime=+new Date();
        this.data = data
    }

    async getData():Promise<T|null|undefined>{

        if(this.busy)
            return new Promise((resolve,reject)=>this.callbacks.subscribe((d)=>resolve(d)))
        
        if(this.lastRequestTime>0 && !this.wasError){
            // check cachetime
            const diff = (+new Date()) - this.lastRequestTime;
            if(diff<this.cacheTime)
                return this.data; // return cached value
        }

        this.busy=true;
        this.wasError=false;
        const res = await this.executor();
        this.busy=false;
        this.wasError=res.error ?? false;
        this.data=res.data
        this.lastRequestTime=+new Date();
        this.callbacks.invoke(this.data);
        this.callbacks.removeAll();
        return this.data;
    }
    
}