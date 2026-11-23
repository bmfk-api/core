import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { migrateSource, migratePackageJson, rootExportNames, migrateModels, projectTypeScript } from "../src/apiServer/deployment/MigrateProject";

const exported = rootExportNames(path.join(__dirname, "..", "..", "src", "index.ts"));

test("the root exports what projects took from dist/…", () => {
    for (const n of ["APIService", "BaseService", "BaseEndpoint", "DefaultErrors", "ErrorUtils", "IInterceptor", "getDefaultOptions",
                     "HTTPRequestVO", "TransferPacketVO", "IRequest", "IResponse", "IError", "REQ_DB", "IDBResult", "LOG_LEVEL", "getDefaultLogOptions",
                     "REQ_MICROSERVICE_CALL", "REQ_TIMEFRAME_TASK_ADD", "ValidationReport", "YYYYMMDDHH_toDate", "HttpMethod", "Signal", "Req", "MysqlAdapter", "PostgresAdapter"])
        assert.ok(exported.has(n), n);
});

test("imports from the root, dist/… and badmfck-signal all become @bmfk/api", () => {
    const src = [
        `import { APIService, Initializer } from "badmfck-api-server";`,
        `import { IInterceptor } from "badmfck-api-server/dist/apiServer/APIService";`,
        `import DefaultErrors, { ErrorUtils } from "badmfck-api-server/dist/apiServer/structures/DefaultErrors";`,
        `import type { HTTPRequestVO } from 'badmfck-api-server/dist/apiServer/structures/Interfaces'`,
        `import Signal, { Req } from "badmfck-signal";`,
        `import * as DB from "badmfck-api-server/dist/apiServer/DBService";`,
        `const { logInfo } = require("badmfck-api-server/dist/apiServer/LogService");`,
        `import { Something } from "./local";`,
    ].join("\n");
    const r = migrateSource(src, "a.ts", exported);
    assert.equal(r.text, [
        `import { APIService, Initializer } from "@bmfk/api";`,
        `import { IInterceptor } from "@bmfk/api";`,
        `import { DefaultErrors, ErrorUtils } from "@bmfk/api";`,
        `import type { HTTPRequestVO } from "@bmfk/api"`,
        `import { Signal, Req } from "@bmfk/api";`,
        `import * as DB from "@bmfk/api";`,
        `const { logInfo } = require("@bmfk/api");`,
        `import { Something } from "./local";`,
    ].join("\n"));
    assert.deepEqual(r.notes, []);
});

test("a default import under another name keeps its name", () => {
    const r = migrateSource(`import Errors from "badmfck-api-server/dist/apiServer/structures/DefaultErrors";`, "a.ts", exported);
    assert.equal(r.text, `import { DefaultErrors as Errors } from "@bmfk/api";`);
});

test("what 1.0 no longer has is listed, not guessed", () => {
    const r = migrateSource([
        `import { ExternalService } from "badmfck-api-server";`,
        `import { s_subscribe } from "badmfck-signal";`,
        `new MicroserviceClient({ id: "crm", host: H, securityKey: K });`,
        `const S = new Signal<string>("S", undefined, handler);`,
    ].join("\n"), "src/x.ts", exported);
    assert.equal(r.notes.length, 4);
    assert.match(r.notes[0], /^src\/x\.ts:1 .*ExternalService/);
    assert.match(r.notes[1], /^src\/x\.ts:2 .*s_subscribe/);
    assert.match(r.notes[2], /^src\/x\.ts:3 .*securityKey/);
    assert.match(r.notes[3], /^src\/x\.ts:4 .*new Signal/);
});

test("package.json: dependency, badmfck-signal, scripts and indentation", () => {
    const before = JSON.stringify({
        name: "shop",
        scripts: {
            deploy: "badmfck deploy",
            deploy2: `node -e 'require("badmfck-api-server").Deploy("deploy.json")'`,
            build: "tsc && badmfck deploy deploy/prod.json",
        },
        dependencies: { axios: "^1.0.0", "badmfck-api-server": "^6.0.12", "badmfck-signal": "^1.4.9" },
        engines: { node: ">=20" },
    }, null, "\t") + "\n";
    const r = migratePackageJson(before);
    const pkg = JSON.parse(r.text);
    assert.deepEqual(pkg.dependencies, { axios: "^1.0.0", "@bmfk/api": "^1.0.0" });
    assert.deepEqual(Object.keys(pkg.dependencies), ["axios", "@bmfk/api"]);   // order kept
    assert.equal(pkg.scripts.deploy, "bmfk deploy");
    assert.equal(pkg.scripts.deploy2, "bmfk deploy deploy.json");
    assert.equal(pkg.scripts.build, "tsc && bmfk deploy deploy/prod.json");
    assert.ok(r.text.startsWith('{\n\t"name"'));
    assert.ok(r.notes.some(n => /Node\.js 24/.test(n)));
});

// The repository root has TypeScript 5 (the parser); packages/api builds with TypeScript 7, which has no JS API.
const ts5 = projectTypeScript(path.join(__dirname, "..", "..", "..", ".."))!;

test("validation models: number samples become 0 plus an explicit bound", () => {
    const src = [
        `const PAY = { amount: 1000, $__amount_min: 1, fee: -5, nested: { qty: 3 }, items: [{ price: 99 }], "page-size": 50 };`,
        `this.registerEndpoints([{ endpoint: "x", handler: this.x, validationModel: { limit: 20, name: "" } }]);`,
        `class A { m = { validationModel: PAY } }`,
        `const notAModel = { retries: 3 };`,
        `const M = { qty: 2, $__qty: { details: "pieces" }, p: 9, $__p: "price" };`,
    ].join("\n");
    const r = migrateModels(src, "a.ts", ts5);
    assert.equal(r.text, [
        `const PAY = { amount: 1000, $__amount_min: 1, fee: 0, $__fee_min: 5, nested: { qty: 0, $__qty_max: 3 }, items: [{ price: 0, $__price_max: 99 }], "page-size": 0, "$__page-size_max": 50 };`,
        `this.registerEndpoints([{ endpoint: "x", handler: this.x, validationModel: { limit: 0, $__limit_max: 20, name: "" } }]);`,
        `class A { m = { validationModel: PAY } }`,
        `const notAModel = { retries: 3 };`,
        `const M = { qty: 0, $__qty_max: 2, $__qty: { details: "pieces" }, p: 0, $__p_max: 9, $__p: "price" };`,
    ].join("\n"));
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /a\.ts:1 .*"amount: 1000" also has min\/max/);
});
