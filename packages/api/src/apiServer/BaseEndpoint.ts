import { Validator } from "./helper/Validator";
import { logCrit, logInfo, logWarn, logError } from "./LogService";
import DefaultErrors from "./structures/DefaultErrors";
import { IRequest, IResponse } from "./structures/Interfaces";
import { Readable } from "stream"

export interface IBaseEndpoint {
	endpoints?: IEndpointHandler[]
	__execute: (req: IRequest) => Promise<IResponse<any>>
	__precheck: (req: IRequest) => Promise<IResponse<any> | null>
	init: () => Promise<void>
	ignoreHttpLogging: boolean,
}

const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE", "CONNECT"]
type HTTPMethod = typeof httpMethods[number];

export type IHandler = Record<HTTPMethod, ((req: IRequest) => Promise<IResponse<any>>) | {
	controller: (req: IRequest) => Promise<IResponse<any>>,
	ignoreInterceptor?: boolean,
	internalCallParams?:any,
	allowInterceptorError?: boolean
	validationModel?: any,
	resultModel?: any, // documentation only: shown as "returns"; the response is not validated or filtered
	asStream?: boolean
	ignoreInDocumentation?: boolean // if true - will not be shown in documentation
	ignoreHttpLogging?: boolean // if true - will not be shown in http logging
	description?: string, // description for documentation
	title?: string, // title for documentation
}>;

export interface IEndpointHandler {
	endpoint: string,
	handler?: ((req: IRequest) => Promise<IResponse<any>>) | IHandler
	ignoreInterceptor?: boolean
	internalCallParams?:any
	ignoreInDocumentation?: boolean // if true - will not be shown in documentation
	ignoreHttpLogging?: boolean // if true - will not be shown in http logging

	independed?: boolean // if true - will allow absolute path linke http://localhost:3000/endepended_endpoint
	allowInterceptorError?: boolean
	asStream?: boolean,
	description?: string, // description for documentation
	title?: string, // title for documentation
	validationModel?: any,
	resultModel?: any, // documentation only: shown as "returns"; the response is not validated or filtered
}

export class BaseEndpoint implements IBaseEndpoint {

	// Registry of every instantiated endpoint — used by the monitor's inventory endpoint
	// to list what's registered in this process. Passive; endpoints live for the process lifetime.
	static allInstances: BaseEndpoint[] = [];

	private inializedEndpointNames: String[] = [];
	description: string = "no description";

	endpoints?: IEndpointHandler[]
	public ignoreHttpLogging = false
	public ignoreInDocumentation = false;
	private static entrypoint: string = "/";
	endpoint = ""

	// Lifecycle markers exposed to the monitor
	createdAt: number = Date.now();
	initializedAt: number | null = null;

	protected streamOptions: Record<string,any>={};


	// global entrypoint
	static setEntryPoint = (ep: string) => {
		this.entrypoint = ep;
		if (!this.entrypoint.endsWith("/")) {
			this.entrypoint += "/"
		}
		if (!ep.startsWith("/"))
			this.entrypoint = "/" + ep;
	}
	static getEntryPoint = (): string => {
		return this.entrypoint;
	}

	constructor(endpoint: string) {
		if (endpoint.startsWith("/"))
			endpoint = endpoint.substring(1)
		if (!endpoint.endsWith("/"))
			endpoint = endpoint + "/"
		this.endpoint = endpoint;
		BaseEndpoint.allInstances.push(this);
	}


	registerEndpoints(endpoints: IEndpointHandler[]) {
		for (let i of endpoints) {

			// base point
			if (i.endpoint === "" || i.endpoint === "/") {
				let empty = i.endpoint === "";
				i.endpoint = this.endpoint
				if (i.endpoint.endsWith("/") && empty)
					i.endpoint = i.endpoint.substring(0, i.endpoint.length - 1)
				continue;
			}

			if (i.endpoint.startsWith("/"))
				i.endpoint = i.endpoint.substring(1)
			if (i.endpoint.endsWith("/"))
				i.endpoint = i.endpoint.substring(0, i.endpoint.length - 1)

			if (!i.independed)
				i.endpoint = this.endpoint + i.endpoint
		}
		this.endpoints = endpoints;
	}


	async init() {
		if (!this.endpoints) {
			logCrit("${BaseEndpoint.js}", "No endpoints registered for " + this.endpoint)
			return;
		}
		for (let i of this.endpoints) {
			const models = [i.validationModel, ...Object.values(i.handler && typeof i.handler === "object" ? i.handler : {}).map((h: any) => h?.validationModel)];
			const samples = models.flatMap(m => Validator.numericSamples(m));
			if (samples.length)
				logWarn(`${i.endpoint}: number sample(s) without min/max — ${samples.join(", ")}. A sample is only the type now, not a limit; write 0, or add $__<field>_max / $__<field>_min if it was meant as one`);
			logInfo("${BaseEndpoint.js}", "endpoint: " + i.endpoint + " initalized, ignoreInterceptor: " + (i.ignoreInterceptor ?? "false"));
			this.inializedEndpointNames.push(i.endpoint + " ignore interceptor: " + (i.ignoreInterceptor ?? "false"))
		}
		this.initializedAt = Date.now();
	};

	getInitalizedEndpointNames(): String[] {
		return this.inializedEndpointNames;
	}

	// Structural snapshot of this endpoint for the monitor inventory endpoint.
	// Introspects registered handlers, listing HTTP methods and per-handler flags.
	getInventory() {
		const handlers: Array<{
			path: string,
			methods: string[],
			ignoreInterceptor: boolean,
			ignoreInDocumentation: boolean,
			ignoreHttpLogging: boolean,
			independed: boolean,
			asStream: boolean,
			hasValidationModel: boolean,
			hasResultModel: boolean,
			description?: string,
			title?: string,
		}> = [];

		for (const i of this.endpoints ?? []) {
			let methods: string[] = [];
			let asStream = i.asStream === true;
			let hasVm = i.validationModel !== undefined;
			let hasRm = i.resultModel !== undefined;

			if (typeof i.handler === "function") {
				methods = ["ANY"];
			} else if (i.handler && typeof i.handler === "object") {
				for (const key of Object.keys(i.handler)) {
					const h = (i.handler as any)[key];
					if (typeof h === "function") {
						methods.push(key);
					} else if (h && typeof h === "object" && typeof h.controller === "function") {
						methods.push(key);
						if (h.asStream) asStream = true;
						if (h.validationModel !== undefined) hasVm = true;
						if (h.resultModel !== undefined) hasRm = true;
					}
				}
			}

			handlers.push({
				path: (BaseEndpoint.entrypoint + i.endpoint).replaceAll("//", "/"),
				methods,
				ignoreInterceptor: i.ignoreInterceptor === true,
				ignoreInDocumentation: i.ignoreInDocumentation === true,
				ignoreHttpLogging: i.ignoreHttpLogging === true,
				independed: i.independed === true,
				asStream,
				hasValidationModel: hasVm,
				hasResultModel: hasRm,
				description: i.description,
				title: i.title,
			});
		}

		return {
			className: this.constructor.name,
			basePath: this.endpoint,
			ignoreHttpLogging: this.ignoreHttpLogging,
			ignoreInDocumentation: this.ignoreInDocumentation,
			description: this.description,
			createdAt: this.createdAt,
			initializedAt: this.initializedAt,
			handlerCount: handlers.length,
			handlers,
		};
	}

	async __precheck(req: IRequest): Promise<IResponse<any> | null> { return null }

	async __execute(req: IRequest): Promise<IResponse<any>> {
		if (this.endpoints && this.endpoints.length > 0) {
			for (let i of this.endpoints) {
				let targetEP = BaseEndpoint.entrypoint + i.endpoint
				targetEP = targetEP.replaceAll("//", "/")

				if (targetEP !== req.endpoint) 
					continue;

				const httpMethod = req.method.toUpperCase() as HTTPMethod;

				// helper: определить asStream для текущего хэндлера
				const resolveAsStream = (): boolean => {
					if (i.asStream) return true;

					if (i.handler && typeof i.handler === "object") {
					const h = i.handler[httpMethod];
					if (h && typeof h === "object" && "asStream" in h && (h as any).asStream) return true;
					}
					return false;
				};

				const asStream = resolveAsStream();

				
					
				if (i.handler && typeof i.handler === "function") {

					if(req.data && req.data.validationModel && req.data.validationModel==="1")
						return {data:i.validationModel}

					if (i.validationModel)
						await this.validateStructure(i.validationModel, req) // throwable

					if (asStream)
						req = this.createStream(req,this.streamOptions[i.endpoint] ?? {});

					const result =await i.handler.call(this, req)
					if(asStream)
						return {blockResponse:true,data:null}
					return result;
				}


				// check method and call controller
				if (i.handler && i.handler[httpMethod] && typeof i.handler[httpMethod] === "function") {
					
					if(req.data && req.data.validationModel && req.data.validationModel==="1")
						return {data:i.validationModel}

					if (i.validationModel)
						await this.validateStructure(i.validationModel, req) // throwable

					if (asStream)
						req = this.createStream(req,this.streamOptions[i.endpoint] ?? {});

					 const result = await (i.handler[httpMethod] as any).call(this, req);

					if(asStream)
						return {blockResponse:true,data:null}

					return result;
				}

				// check method and call controller in handler object
				if (i.handler
					&& i.handler[httpMethod]
					&& typeof i.handler[httpMethod] === "object"
					&& "controller" in i.handler[httpMethod]
					&& typeof (i.handler[httpMethod] as any).controller === "function") {
						
					const vmodel = (i.handler[httpMethod] as any).validationModel;

					if(req.data && req.data.validationModel && req.data.validationModel==="1")
						return {data:vmodel}

					if (vmodel)
						await this.validateStructure(vmodel, req) // throwable

					if (asStream)
						req = this.createStream(req,this.streamOptions[i.endpoint] ?? {});

					const result = await (i.handler[httpMethod] as any).controller.call(this, req);

					if (asStream)
						return {blockResponse:true,data:null}
					return result;
				}


			
			

				// No handler for http method
				return {
					error: { ...DefaultErrors.METHOD_NOT_ALLOWED, details: "No handler for " + httpMethod },
					data: null
				}
				

			}
		}

		logWarn("${BaseEndpoint.js}", "Unhandled entrypoint: " + this.endpoint)

		return {
			error: DefaultErrors.NOT_IMPLEMENTED,
			data: null
		}
	}

	// throwable
	protected async validateStructure(structure: any, req: IRequest) {
		if (!structure)
			return;
		if (typeof structure === "object" && (!req.data || typeof req.data !== "object"))
			throw { ...DefaultErrors.WRONG_PARAMS, details: "empty or invalid request" }

		const report = await Validator.validateStructure(structure, req.data)
		if (report)
			throw { ...DefaultErrors.WRONG_PARAMS, details: report }

		// strict structure
		Validator.filterStructure(structure, req.data)

	}

	protected createStream(req: IRequest,opts:{
		contentType?:string,
		headers?:{[key:string]:string}
	}): IRequest {
		const res = req.response;

		if(res.headersSent)
			throw {...DefaultErrors.INTERNAL_SERVER_ERROR,details:"Headers already sent, can't create stream"}

		res.statusCode=200;
		res.setHeader("Content-Type", opts?.contentType ?? "application/octet-stream");
  		res.setHeader("Transfer-Encoding", "chunked");
  		res.setHeader("Cache-Control", "no-cache");
		if(opts?.headers){
			for(let h in opts.headers){
				res.setHeader(h,opts.headers[h]);
			}
		}

		// create a readable stream
		const stream = new Readable({
			read(){
				// push from controller
			}
		})

		let finished = false;
		let timer: NodeJS.Timeout | undefined;

		const cleanup = () =>{
			if (finished) return;
  				finished = true;
			if (timer) clearTimeout(timer);
			try{
				if(!stream.destroyed){
					stream.destroy();
				}
			}catch(e){
				logError("Error during stream cleanup:",e);
			}
			try {
				if (!res.writableEnded) res.end();
			} catch {}
		}

		const endOk = () =>{
			if (finished) return;
  				finished = true;
			if (timer) clearTimeout(timer);

			try {
				if (!stream.destroyed) stream.push(null); // EOF
			} catch (e) {
				cleanup();
			}
		}

		res.on('close', () => {
			cleanup();
		});

		const setupTimer = () =>{
			if( finished) return;
			if (timer)
				clearTimeout(timer);
			timer = setTimeout(() => cleanup(), 60_000);
		}

		setupTimer();
		

		const origPush = stream.push.bind(stream);
		stream.push = (chunk:any, encoding?: BufferEncoding): boolean => {
			if (chunk === null)
  				return origPush(null as any);
			if (finished) return false;
			setupTimer();
			return origPush(chunk, encoding);
		};

		(req.raw as any)?.on?.("aborted", ()=>{
			cleanup();
			try { (res as any).destroy?.(); } catch {}
		});
		(req.raw as any)?.on?.("close", cleanup);

		stream.on('error', (err) => {
			logError("Stream error:", err);
			cleanup();
			try { (res as any).destroy?.(err); } catch { res.end(); }
		});


		res.on("finish", cleanup);


		// send the stream to the client
		stream.pipe(res);
		req.stream = stream;
		req.endStream = (force?:boolean)=>force?cleanup():endOk();
		return req;
	}
}