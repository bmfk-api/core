import { Req } from "../signal/Signal";
import { BaseEndpoint, IBaseEndpoint, IHandler } from "./BaseEndpoint";
import { Validator } from "./helper/Validator";


export const REQ_DOC = new Req<void, Record<string, any>[]>(undefined,"REQ_DOC")

export class DocumentGenerator {

	endpoints: BaseEndpoint[] = [];
	documentation: Record<string, any>[] = [];

	constructor(endpoints:BaseEndpoint[]) {
		this.endpoints = endpoints;
		this.generateDocumentation();
		REQ_DOC.listener = async () => this.documentation;
	}

	
	private generateDocumentation = () => {
		
		
		for(let i of this.endpoints) {

			
			// Only ignoreInDocumentation hides things here. ignoreHttpLogging is about the netlog —
			// silencing a noisy endpoint must not erase its documentation as a side effect.
			if(i.ignoreInDocumentation)
				continue;

			const branch={
				name:i.endpoint,
				description:i.description,
				endpoints:[] as Record<string, any>[]
			}

			

			// add endpoints
			for(let j of i.endpoints || []) {
				if(j.ignoreInDocumentation)
					continue;

				
				const endpoint:Record<string, any> = {}
				endpoint.name = j.endpoint;
				endpoint.methods={} as Record<string, any>;
				if(typeof j.handler === "function"){
					const method=j.validationModel?"POST":"GET"
					endpoint.methods[method]={
						title: j.title || "",
						description: j.description,
						parameters:Validator.documentStructure(j.validationModel),
						authorized:!j.ignoreInterceptor,
						returns: j.resultModel ? Validator.documentStructure(j.resultModel) : undefined
					}
				}else if(typeof j.handler === "object") {
					for(const method in j.handler) {
						const methodHandler = (j.handler as IHandler)[method];
						if(!methodHandler)
							continue;

						// Per-method handler may be either a plain controller function or an object
						// with metadata ({controller, validationModel, resultModel, ...}). For the
						// function form there is no per-method metadata, so fall back to endpoint level.
						const meta = typeof methodHandler === "object" ? methodHandler : null;

						if(meta && meta.ignoreInDocumentation)
							continue;

						const validationModel = meta?.validationModel ?? j.validationModel;
						const resultModel = meta?.resultModel ?? j.resultModel;

						endpoint.methods[method.toUpperCase()] = {
							title: meta?.title || j.title || "",
							description: meta?.description || j.description,
							parameters: Validator.documentStructure(validationModel),
							authorized: !(meta?.ignoreInterceptor ?? j.ignoreInterceptor),
							returns: resultModel ? Validator.documentStructure(resultModel) : undefined
						};
					}
				}
				branch.endpoints.push(endpoint);
			}
							
			this.documentation.push(branch);
		}

	}



}

	