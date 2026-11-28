// Readiness checks of the app: what must work for it to serve requests (the database, a queue…).
//
//   APIService.addReadinessCheck("db", async () => { await db.query("SELECT 1"); return true; });
//
// A check returns true (fine), or false / a text / throws (not ready; the text says why). Each runs
// with a time limit. GET /readiness answers 503 while one fails, with no details (it is public); the
// details go to the log and to `bmfk ps show` over the control channel. With no checks the app is
// always ready, as before.

import { IControlReady } from "./Control";

export type ReadinessCheck = () => boolean | string | Promise<boolean | string>;

const checks = new Map<string, ReadinessCheck>();

export function addReadinessCheck(name: string, check: ReadinessCheck): () => void {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`readiness check name "${name}": letters, digits, . _ - only, up to 64`);
    if (checks.has(name)) throw new Error(`readiness check "${name}" is already added`);
    checks.set(name, check);
    return () => { checks.delete(name); };
}

export async function runReadinessChecks(timeoutMs = 2000): Promise<IControlReady> {
    const results = await Promise.all([...checks].map(async ([name, check]) => {
        const started = Date.now();
        let timer: NodeJS.Timeout | undefined;
        try {
            const r = await Promise.race([
                Promise.resolve().then(check),
                new Promise<string>(res => { timer = setTimeout(() => res(`no answer in ${timeoutMs} ms`), timeoutMs); }),
            ]);
            const ok = r === true;
            return { name, ok, ...(ok ? {} : { detail: typeof r === "string" ? r : "not ready" }), ms: Date.now() - started };
        } catch (e: any) {
            return { name, ok: false, detail: String(e?.message ?? e).slice(0, 300), ms: Date.now() - started };
        } finally { if (timer) clearTimeout(timer); }
    }));
    return { ready: results.every(r => r.ok), checks: results };
}
