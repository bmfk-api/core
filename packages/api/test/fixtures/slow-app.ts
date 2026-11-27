// A child process for control.test.ts: an API with a slow endpoint, stopped with SIGTERM by the test.
import { BaseEndpoint } from "../../src/apiServer/BaseEndpoint";
import { IResponse } from "../../src/apiServer/structures/Interfaces";
import { startApi } from "../helpers";

class Slow extends BaseEndpoint {
    constructor() {
        super("slow");
        this.registerEndpoints([{ endpoint: "", ignoreInterceptor: true, handler: async (): Promise<IResponse> => {
            await new Promise(r => setTimeout(r, 800));
            return { data: "done" };
        } }]);
    }
}

const port = Number(process.argv[2]);
startApi(port, [], { endpoints: [new Slow()], shutdownTimeoutMs: Number(process.argv[3] ?? 10000) } as any)
    .then(() => process.stdout.write("ready\n"));
