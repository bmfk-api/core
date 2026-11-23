// `npm run sandbox` (repository root): the app on :18900 and a ledger microservice on :18901, with a
// little traffic of their own so the monitor has something to show. Data lives in examples/sandbox/.data
// (2FA enrollments survive restarts; delete the folder to start over).
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, ".data");
// Before the library loads: each process gets its own data folder.
process.env.BMFK_DATA_DIR = path.join(DATA, "app");
fs.mkdirSync(process.env.BMFK_DATA_DIR, { recursive: true });

import {
    APIService, Initializer, getDefaultOptions, LogService, getDefaultLogOptions, LOG_LEVEL,
    MicroserviceClient, InterceptorSignedAuth, S_WS_ON_MESSAGE,
} from "@bmfk/api";
import { Demo } from "./Demo";
import { LEDGER_PORT } from "./ledger";

const PORT = 18900;
const BASE = `http://localhost:${PORT}/api`;

// Keys for this run only: the ledger knows the app by its public key, the app checks the ledger's answers.
const appKeys = InterceptorSignedAuth.generateKeyPair();
const ledgerKeys = InterceptorSignedAuth.generateKeyPair();

const ledger = spawn(process.execPath, [path.join(__dirname, "ledger.js")], {
    env: { ...process.env, BMFK_DATA_DIR: path.join(DATA, "ledger"), LEDGER_PRIVATE_KEY: ledgerKeys.privateKey, APP_PUBLIC_KEY: appKeys.publicKey },
    stdio: ["inherit", "inherit", "inherit", "ipc"],   // the channel closes if this process dies: the ledger stops too
});
const stop = () => { ledger.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const logOpt = getDefaultLogOptions();
logOpt.output = item => process.stdout.write(`[app]    ${LOG_LEVEL[item.level]} ${item.text}\n`);

Initializer([
    new LogService(logOpt),
    new APIService(getDefaultOptions({
        port: PORT,
        baseEndPoint: "/api/",
        projectName: "bmfk sandbox",
        endpoints: [new Demo()],
        access: path.join(ROOT, "access.json"),
        corsHostWhiteList: ["http://localhost:3000", "http://localhost:3001"],   // the UIs' dev servers (npm run monitor / api-docs)
        websocketServer: {
            endpoint: "ws",
            onAuthorize: (_connection, message) => message?.token === "sandbox" ? { user: "sandbox" } : false,
        },
    })),
    new MicroserviceClient({
        id: "ledger", host: `http://localhost:${LEDGER_PORT}/api`,
        kid: "app", privateKey: appKeys.privateKey, hostPublicKey: ledgerKeys.publicKey,
    }),
]).then(() => {
    console.log(`
  bmfk sandbox
  ────────────────────────────────────────────────────────────
  Start here   ${BASE}/demo/page
  Monitor      ${BASE}/sm/html     admin / sandbox  (2FA is set up at the first sign-in)
  API docs     ${BASE}/doc/html    doc / sandbox    (2FA as well)
  Ledger       http://localhost:${LEDGER_PORT}/api  (signed microservice host)
  Data         ${DATA}
  Ctrl+C stops both.
`);
    setInterval(traffic, 3000);
});

S_WS_ON_MESSAGE.subscribe(({ connection, message }) => {
    connection.send({ echo: message, at: new Date().toISOString() });
});

// Some background calls, so charts, journals and traces fill up without clicking.
let tick = 0;
async function traffic() {
    tick++;
    const post = (ep: string, body: unknown) =>
        fetch(`${BASE}/demo/${ep}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
        await fetch(`${BASE}/demo/hello`);
        await post("echo", tick % 7 === 0 ? { name: "Ann", amount: 0, currency: "EUR" } : { name: "Ann", amount: tick % 100 + 1, currency: "EUR" });
        if (tick % 3 === 0) await post("pay", { amount: tick % 20 === 0 ? 5000 : 10 + tick % 50, currency: "USD" });
        if (tick % 10 === 0) await fetch(`${BASE}/demo/slow`);
        if (tick % 25 === 0) await fetch(`http://localhost:${PORT}/wp-login.php`);   // a probe, for the threat monitor
    } catch { /* the app is restarting */ }
}
