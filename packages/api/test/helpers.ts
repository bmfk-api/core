import { after } from "node:test";
import { APIService, Initializer, getDefaultOptions } from "../src/apiServer/APIService";
import { LogService, getDefaultLogOptions, ILogItem } from "../src/apiServer/LogService";
import { BaseService } from "../src/apiServer/BaseService";
import fs from "fs";
import os from "os";
import path from "path";

// Project data (/var/bmfk/…) goes to a throwaway folder: tests never touch a real one.
process.env.BMFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bmfk-test-"));

// Services keep timers running; once a file's tests are done its process is ended explicitly.
export function exitWhenDone() {
    after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
}

export interface ITestApi { url: string, logs: ILogItem[] }

/** Starts an APIService on `port` with the given extra services and options; collects every log item. */
export async function startApi(port: number, services: BaseService[] = [], options: Parameters<typeof getDefaultOptions>[0] = {}): Promise<ITestApi> {
    const logs: ILogItem[] = [];
    const logOpt = getDefaultLogOptions();
    logOpt.output = item => { logs.push(item); };
    await Initializer([
        new LogService(logOpt),
        new APIService(getDefaultOptions({ port, baseEndPoint: "/api/", blockedIps: false, threatMonitoring: false, metricsDir: false, ...options })),
        ...services,
    ]);
    await waitFor(async () => {
        try { await fetch(`http://localhost:${port}/api/liveness`); return true; } catch { return false; }
    });
    return { url: `http://localhost:${port}/api`, logs };
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error("timed out waiting");
}
