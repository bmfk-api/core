import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseEndpoint } from "../src/apiServer/BaseEndpoint";
import { IResponse } from "../src/apiServer/structures/Interfaces";
import DefaultErrors from "../src/apiServer/structures/DefaultErrors";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

class Failing extends BaseEndpoint {
    constructor() {
        super("fail");
        this.registerEndpoints([
            { endpoint: "throw", handler: async (): Promise<IResponse> => { throw new Error("SELECT * FROM cards WHERE pan='4111…'"); } },
            { endpoint: "db", handler: async (): Promise<IResponse> => { throw { code: "ER_NO_SUCH_TABLE", errno: 1146, name: "Error", message: "Table 'pay.secret_table' doesn't exist" }; } },
            { endpoint: "ierror", handler: async (): Promise<IResponse> => { throw { ...DefaultErrors.FORBIDDEN, details: "not yours", stack: [{ code: 1, message: "http://10.0.0.5:9000/internal" }] }; } },
            { endpoint: "returned", handler: async (): Promise<IResponse> => ({ error: { ...DefaultErrors.EXTERNAL_SERVICE_ERROR, stack: ["https://ledger.internal/api"] as any } }) },
        ]);
    }
}

const PORT = 18811;
const ready = startApi(PORT, [], { endpoints: [new Failing()] });   // production: NODE_ENV is not "development"
const get = async (ep: string) => { const r = await fetch(`http://localhost:${PORT}/api/fail/${ep}`); return { status: r.status, body: await r.json() as any }; };

test("an unexpected exception: 500 with a generic message, the cause stays in the log", async () => {
    const api = await ready;
    const r = await get("throw");
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, DefaultErrors.INTERNAL_SERVER_ERROR.code);
    assert.equal(r.body.error.details, undefined);
    assert.ok(!JSON.stringify(r.body).includes("cards"));
    assert.ok(api.logs.some(l => l.text.includes("SELECT * FROM cards")));
});

test("a database failure does not show the database's message", async () => {
    await ready;
    const r = await get("db");
    assert.equal(r.body.error.code, DefaultErrors.DB_ERROR.code);
    assert.ok(!JSON.stringify(r.body).includes("secret_table"));
});

test("an IError thrown on purpose goes out, without its stack", async () => {
    await ready;
    const thrown = await get("ierror");
    assert.equal(thrown.status, 403);
    assert.equal(thrown.body.error.details, "not yours");
    assert.equal(thrown.body.error.stack, undefined);
    const returned = await get("returned");
    assert.equal(returned.body.error.code, DefaultErrors.EXTERNAL_SERVICE_ERROR.code);
    assert.equal(returned.body.error.stack, undefined);
});
