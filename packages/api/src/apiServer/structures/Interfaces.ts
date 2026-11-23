import { FileArray, UploadedFile } from "express-fileupload"
import { Readable } from "stream"

/** What a handler returns: the response envelope. */
export interface IResponse<T=any>{
    data?:T|null,
    error?:IError|null,
    responseTime?:number
    traceId?:string
    version?:string,
    core?:string,
    endpoint?:string
    httpStatus?:number,
    redirect?:string
    rawResponse?:boolean
    headers?:{[key:string]:string}
    file?:string,
    blockResponse?:boolean
    project?:string
    ignoreHttpLogging?:boolean
}

/** What a handler receives: the incoming request. */
export interface IRequest<T=any,TInterceptor=any>{
    raw:any,
    response:any,
    method:string,
    data:T,
    params:{[key:string]:string},
    headers:Record<string,string>,
    endpoint:string
    interceptorResult?:any
    preproducerResult?:any
    precheck?:IResponse<any>|null
    files:FileArray | null | undefined
    referer?:string
    ip?:string              // real client address (proxy headers trusted only from options.trustedProxies)
    traceId?:string         // this request's id: X-Request-Id of the response, `traceId` in logs (helper/Trace)
    unlocked?:boolean
    internalCall?:boolean
    stream?:Readable
    endStream?:(force?:boolean)=>void
    internalCallParams?:any
}

export interface IError{
    code:number,
    message:string,
    details?:string,
    httpStatus?:number
    stack?:IError[]
}

/** @deprecated The old name of {@link IRequest}; it keeps working. */
export interface HTTPRequestVO<T=any,TInterceptor=any> extends IRequest<T,TInterceptor>{}
/** @deprecated The old name of {@link IResponse}; it keeps working. */
export interface TransferPacketVO<T=any> extends IResponse<T>{}
