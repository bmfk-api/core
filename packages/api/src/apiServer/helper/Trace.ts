import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";

// One id per incoming request, carried through everything that request causes: the response
// (X-Request-Id header and `traceId` in the envelope), the request log, every log line written while
// handling it, outgoing HTTP calls in the monitor, and signed microservice calls — where the host
// adopts the caller's id, so one operation has one id across services.
//
// An X-Request-Id header is taken only from a trusted proxy (nginx: `proxy_set_header X-Request-Id
// $request_id;` gives the same id in nginx's access log). From anyone else it is ignored: a client
// must not be able to plant an id that collides with someone else's records.

export const TRACE_HEADER = "x-request-id";
const VALID = /^[A-Za-z0-9._:-]{8,128}$/;

interface ITraceContext { traceId: string }

const storage = new AsyncLocalStorage<ITraceContext>();

export const Trace = {
    newId(): string {
        return crypto.randomUUID();
    },

    isValid(id: unknown): id is string {
        return typeof id === "string" && VALID.test(id);
    },

    /** The id of the request being handled, or null outside a request. */
    current(): string | null {
        return storage.getStore()?.traceId ?? null;
    },

    /** Runs fn with this trace id; everything fn starts, sync or async, sees it. */
    run<T>(traceId: string, fn: () => T): T {
        return storage.run({ traceId }, fn);
    },

    /**
     * Replaces the current id with one from an authenticated source (a signed microservice call).
     * Ignored outside a request or when the id is malformed.
     */
    adopt(traceId: unknown): void {
        const ctx = storage.getStore();
        if (ctx && Trace.isValid(traceId)) ctx.traceId = traceId;
    },
};
