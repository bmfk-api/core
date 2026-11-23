import { REQ_HTTP_REQUESTS_COUNT } from "../APIService";
import { BaseEndpoint } from "../BaseEndpoint"
import { IRequest } from "../structures/Interfaces"

export class Readiness extends BaseEndpoint{
    started:Date;
    constructor(stated:Date){
        super("readiness")
        this.started=stated;
        this.ignoreInDocumentation=true;
        this.ignoreHttpLogging=true
        this.registerEndpoints([{endpoint:"",handler:this.checkReadiness,ignoreInterceptor:true}])
    }

    async checkReadiness (req:IRequest){
        const request = await REQ_HTTP_REQUESTS_COUNT.request()
        return {data:{liveness:true,wakeTime:(+new Date()) - (+this.started),request:request}}
    }
}