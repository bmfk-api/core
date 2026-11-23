import { BaseEndpoint } from "../BaseEndpoint";
import DefaultErrors from "../structures/DefaultErrors";
import { IRequest, IResponse } from "../structures/Interfaces";
import { REQ_DEPLOYMENT_PROCEED, REQ_DEPLOYMENT_SWITCH, REQ_DEPLOYMENT_STATUS, REQ_DEPLOYMENT_SLOT, REQ_DEPLOYMENT_BACKUPS, REQ_DEPLOYMENT_RESTORE, REQ_DEPLOYER_PUBLIC_KEY } from "./DeployerService";
import { InterceptorSignedAuth } from "../interceptors/InterceptorSignedAuth";


// Server side
export class Deployer extends BaseEndpoint{

    ignoreInDocumentation=true

    // Checks Ed25519-signed requests against the deployer users' public keys (setup.json). One
    // instance for every endpoint, so a nonce can't be spent twice across them.
    private signed = new InterceptorSignedAuth(login => REQ_DEPLOYER_PUBLIC_KEY.request(login));

    constructor(){
        super("pckg");
        this.registerEndpoints([
            {
                ignoreInterceptor:true,
                endpoint:"add",
                handler: this.file,
                validationModel:{
                    token:"",
                    name:"",
                }
            },
            {
                ignoreInterceptor:true,
                endpoint:"switch",
                handler: this.switchSlot,
                validationModel:{
                    token:"",
                    name:"",
                    scheme:"",
                    $__scheme_values:["blue","green"],
                    $__scheme_optional:true
                }
            },
            {
                ignoreInterceptor:true,
                endpoint:"status",
                handler: this.status,
                validationModel:{
                    name:"",
                    $__name_optional:true
                }
            },
            {
                // Polled by deployed apps (APIService.getBlueGreenActiveState) — kept out of the
                // netlog so the periodic checks don't flood it or record the status token.
                ignoreInterceptor:true,
                ignoreHttpLogging:true,
                endpoint:"slot",
                handler: this.slot,
                validationModel:{
                    name:"",
                    token:"",
                    slot:"",
                    $__slot_values:["blue","green"],
                    $__slot_optional:true
                }
            },
            {
                ignoreInterceptor:true,
                endpoint:"backups",
                handler: this.backups,
                validationModel:{ name:"" }
            },
            {
                ignoreInterceptor:true,
                endpoint:"restore",
                handler: this.restore,
                validationModel:{ name:"", token:"", backup:"" }
            }
        ])
    }

    async file(req:IRequest):Promise<IResponse<any>>{

        if(!req.files)
            throw {...DefaultErrors.FILE_NOT_EXISTS,details:"No files were uploaded"}

        const result = await REQ_DEPLOYMENT_PROCEED.request({...req.data,files:req.files,auth:req.headers.authorization, authLogin:req.headers["x-deployer-login"] as string, ip:req.ip, sig:await this.signed.verify(req)})

        return {data:result}

    }

    // Pass-through: the service already returns a IResponse-shaped result
    // ({data:...} or {error:{...,httpStatus}}). Returning it directly preserves the
    // HTTP status semantics of errors.
    async switchSlot(req:IRequest):Promise<IResponse<any>>{
        return await REQ_DEPLOYMENT_SWITCH.request({...req.data,auth:req.headers.authorization, authLogin:req.headers["x-deployer-login"] as string, ip:req.ip, sig:await this.signed.verify(req)})
    }

    async status(req:IRequest):Promise<IResponse<any>>{

        return await REQ_DEPLOYMENT_STATUS.request({...req.data,auth:req.headers.authorization, authLogin:req.headers["x-deployer-login"] as string, ip:req.ip, sig:await this.signed.verify(req)})
    }

    async backups(req:IRequest):Promise<IResponse<any>>{
        return await REQ_DEPLOYMENT_BACKUPS.request({name:req.data.name, auth:req.headers.authorization, authLogin:req.headers["x-deployer-login"] as string, ip:req.ip, sig:await this.signed.verify(req)})
    }

    async restore(req:IRequest):Promise<IResponse<any>>{
        return await REQ_DEPLOYMENT_RESTORE.request({name:req.data.name, token:req.data.token, backup:req.data.backup, auth:req.headers.authorization, authLogin:req.headers["x-deployer-login"] as string, ip:req.ip, sig:await this.signed.verify(req)})
    }

    // No user auth: the per-project statusToken in the body is the credential.
    async slot(req:IRequest):Promise<IResponse<any>>{
        return await REQ_DEPLOYMENT_SLOT.request({name:req.data.name, token:req.data.token, slot:req.data.slot})
    }

}
