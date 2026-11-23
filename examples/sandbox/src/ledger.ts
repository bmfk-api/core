// The second service of the sandbox: a microservice host started by main.ts with keys made for this run.
import {
    APIService, Initializer, getDefaultOptions, LogService, getDefaultLogOptions,
    MicroserviceHost, Req, DefaultErrors, logInfo, LOG_LEVEL,
} from "@bmfk/api";

export const LEDGER_PORT = 18901;

interface IPost { amount: number; currency: string }
interface IPosted { entry: string; balance: number }

const REQ_LEDGER_POST = new Req<IPost, IPosted>(undefined, "REQ_LEDGER_POST");
let balance = 0;

REQ_LEDGER_POST.listener = async post => {
    const call = MicroserviceHost.currentCall();
    logInfo(`Ledger: ${post.amount} ${post.currency} from "${call?.caller}", op ${call?.op}`);
    if (post.amount > 1000)
        throw { ...DefaultErrors.FORBIDDEN, details: "over the sandbox limit of 1000" };
    balance += post.amount;
    return { entry: call?.op ?? "", balance };
};

if (require.main === module) {
    process.on("disconnect", () => process.exit(0));
    const logOpt = getDefaultLogOptions();
    logOpt.output = item => process.stdout.write(`[ledger] ${LOG_LEVEL[item.level]} ${item.text}\n`);
    Initializer([
        new LogService(logOpt),
        new APIService(getDefaultOptions({ port: LEDGER_PORT, baseEndPoint: "/api/", projectName: "sandbox ledger", endpoints: [] })),
        new MicroserviceHost({
            id: "ledger",
            requests: [REQ_LEDGER_POST],
            privateKey: process.env.LEDGER_PRIVATE_KEY!,
            clients: { app: { publicKey: process.env.APP_PUBLIC_KEY!, allowedIps: ["127.0.0.1", "::1"] } },
        }),
    ]);
}
