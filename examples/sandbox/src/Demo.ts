import fs from "fs";
import path from "path";
import {
    BaseEndpoint, IRequest, IResponse, ErrorUtils, REQ_MICROSERVICE_CALL, logInfo, logWarn,
} from "@bmfk/api";

const PAGE = path.join(__dirname, "..", "page.html");

/** Endpoints to try every part of the framework by hand. All under <baseEndPoint>demo/. */
export class Demo extends BaseEndpoint {
    constructor() {
        super("demo");
        this.description = "Sandbox endpoints: one of each kind of thing a service does.";
        this.registerEndpoints([
            { endpoint: "page", handler: this.page, ignoreInDocumentation: true, ignoreHttpLogging: true },
            {
                endpoint: "hello", title: "Say hello",
                description: "The simplest endpoint: no input, a small answer.",
                handler: this.hello,
                resultModel: { message: "hello", at: "2026-01-01T00:00:00.000Z" },
            },
            {
                endpoint: "echo", title: "Echo a validated body",
                description: "Send a body that breaks the model (no name, amount 0 or over 1000) to see a 400.",
                handler: this.echo,
                validationModel: { name: "Ann", amount: 0, $__amount_min: 1, $__amount_max: 1000, currency: "EUR", $__currency_values: ["EUR", "USD"] },
            },
            {
                endpoint: "pay", title: "Pay through the ledger microservice",
                description: "A signed call to the second service. Amounts over 1000 are refused by the ledger.",
                handler: this.pay,
                validationModel: { amount: 0, $__amount_min: 1, currency: "EUR", $__currency_values: ["EUR", "USD"] },
            },
            { endpoint: "card", title: "Log card data", description: "Logs a PAN and CVV: the log shows them masked.", handler: this.card, validationModel: { pan: "4111111111111111" } },
            { endpoint: "slow", title: "Slow answer", description: "Answers after 1.5 s, for the latency charts.", handler: this.slow },
            { endpoint: "boom", title: "Unexpected exception", description: "The handler throws; the caller gets a bare 500.", handler: this.boom },
        ]);
    }

    async page(): Promise<IResponse> {
        return { data: fs.readFileSync(PAGE, "utf-8"), rawResponse: true, headers: { "Content-Type": "text/html; charset=utf-8" } };
    }

    async hello(): Promise<IResponse> {
        return { data: { message: "hello", at: new Date().toISOString() } };
    }

    async echo(req: IRequest): Promise<IResponse> {
        return { data: { received: req.data } };
    }

    async pay(req: IRequest<{ amount: number, currency: string }>): Promise<IResponse> {
        const result = await REQ_MICROSERVICE_CALL.request({ id: "ledger", requestName: "REQ_LEDGER_POST", requestData: req.data });
        if (ErrorUtils.isError(result)) return { error: result };
        logInfo(`Paid ${req.data.amount} ${req.data.currency}`);
        return { data: result };
    }

    async card(req: IRequest<{ pan: string }>): Promise<IResponse> {
        logWarn("Card received", { pan: req.data.pan, cvv: "123", cardholder: "ANN EXAMPLE" });
        return { data: { stored: false } };
    }

    async slow(): Promise<IResponse> {
        await new Promise(r => setTimeout(r, 1500));
        return { data: { slept: 1500 } };
    }

    async boom(): Promise<IResponse> {
        throw new Error("sandbox: something nobody expected (the stack stays in the log)");
    }
}
