import { BaseEndpoint } from "../BaseEndpoint";
import DefaultErrors, { ErrorUtils } from "../structures/DefaultErrors";
import { IRequest, IResponse } from "../structures/Interfaces";
import { MicroserviceHost } from "./MicroserviceHost";


export class MicroserviceHostController extends BaseEndpoint {
    constructor(){
        super("__ms_host_control")
        this.ignoreInDocumentation=true;
        this.ignoreHttpLogging=true
        this.registerEndpoints([{
            ignoreInDocumentation:true,
            endpoint:"receiver",
            handler:this.receiver,
            ignoreInterceptor:true,
        },
    ])
    }

    async receiver(req:IRequest):Promise<IResponse>{

        if(req.method.toUpperCase() !== "POST")
            throw DefaultErrors.METHOD_NOT_ALLOWED

        const microserviceHost = MicroserviceHost.getMicroservice(req.headers["x-microservice-id"] as string);
        if(!microserviceHost)
            throw {...DefaultErrors.NOT_FOUND,message:"Microservice host not found with id: "+req.headers["x-microservice-id"]}

        const result = await microserviceHost.handleIncomingRequest(req);
        if(ErrorUtils.isError(result))
            throw result;
        return {data:result};
    }
}
