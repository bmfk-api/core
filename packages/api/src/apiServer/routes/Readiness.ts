import { APIService, REQ_HTTP_REQUESTS_COUNT } from "../APIService";
import { BaseEndpoint } from "../BaseEndpoint"
import { IRequest } from "../structures/Interfaces"
import { runReadinessChecks } from "../control/ReadinessChecks";
import { logInfo, logWarn } from "../LogService";

// GET /readiness: 200 when every readiness check passes (APIService.addReadinessCheck), 503 while one
// fails or while the app is stopping. Public, so the answer says only that — the failing checks and
// their reasons go to the log (once per change) and to `bmfk ps show`.
export class Readiness extends BaseEndpoint{
    started:Date;
    private lastProblem: string | null = null;
    constructor(stated:Date){
        super("readiness")
        this.started=stated;
        this.ignoreInDocumentation=true;
        this.ignoreHttpLogging=true
        this.registerEndpoints([{endpoint:"",handler:this.checkReadiness,ignoreInterceptor:true}])
    }

    async checkReadiness (req:IRequest){
        const request = await REQ_HTTP_REQUESTS_COUNT.request()
        const result = await runReadinessChecks();
        const problem = APIService.draining ? "stopping"
            : result.ready ? null : result.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail ?? "not ready"}`).join("; ");
        if (problem !== this.lastProblem) {
            if (problem) logWarn(`Not ready — ${problem}`);
            else logInfo("Ready again");
            this.lastProblem = problem;
        }
        const ready = problem === null;
        return {data:{liveness:true,ready,wakeTime:(+new Date()) - (+this.started),request:request}, httpStatus: ready ? 200 : 503}
    }
}
