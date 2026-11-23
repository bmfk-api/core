import { REQ_HTTP_REQUESTS_COUNT } from "../APIService";
import { BaseEndpoint } from "../BaseEndpoint";
import { IRequest, IResponse } from "../structures/Interfaces";

export class Liveness extends BaseEndpoint{
    started:Date;
    constructor(stated:Date){
        super("liveness")
        this.ignoreInDocumentation=true;
        this.ignoreHttpLogging=true
        this.started=stated;
        this.registerEndpoints([{endpoint:"",handler:this.checkLiveness,ignoreInterceptor:true}])
    }

    async checkLiveness (req:IRequest){
        // liveness probe - check if server is alive (wait for 10 sec and send response)
        const request = REQ_HTTP_REQUESTS_COUNT.request()
        const data = {data:{liveness:true,wakeTime:(+new Date()) - (+this.started),request:request}}
        let cb:((data:IResponse<any>)=>void) | null = null;
        const p = new Promise<IResponse<any>>((resolve,reject)=>{cb = resolve})
        setTimeout(()=>{
            if(cb)
                cb(data);
        },1000*4)
        return p;
    }
}