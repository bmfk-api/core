// Http.ts
// Undici-based HTTP client (axios-like static class) with:
// - shared Agent (dispatcher) by default
// - timeout via AbortController
// - retry policy (statuses + network errors)
// - JSON/text/raw response handling
// - hooks (onRequest/onResponse/onError)
// - active TCP/TLS connection counters: total + per host (protocol//hostname:port)
// - enable/disable connection counter subscriptions
//
// - diagnostics_channel Channel<...> has no .on/.off
// - Channel.subscribe/unsubscribe are marked deprecated in types, but are the workable API here
//   so we isolate usage to one place with @ts-expect-error.


/*import { Http } from "./Http";

// Optionally override defaults (creates shared Agent if dispatcher not provided)
Http.configure({ timeoutMs: 7000 });

// Read connection metrics
console.log(Http.getActiveConnectionsSnapshot());

// Disable counters (e.g., in tests)
Http.disableConnectionCounterByHost({ reset: true });*/

/* GET
const res = await Http.get<{ status: string }>("/health", {
  query: {
    verbose: true,
  },
});

if (!res.ok) {
  throw new Error("Healthcheck failed");
}

console.log(res.data.status);*/


/* POST type TYapilyAccount = {
  id: string;
  name: string;
};

const auth = Http.basicAuth(app.applicationUuid, app.secret);

const res = await Http.post<TYapilyAccount[]>(
  "https://api.yapily.com/accounts",
  {
    consentId: "consent-123",
  },
  {
    headers: {
      Authorization: auth,
      "content-type": "application/json",
    },
    timeoutMs: 7000,
  }
);

if (!res.ok) {
  logger.error(res, "Yapily accounts request failed");
  throw new Error("Yapily API error");
}

return res.data;
*/


/* POST NO RETRY
const res = await Http.post(
  "https://api.partner.com/payments",
  paymentPayload,
  {
    retry: { enabled: false },
    timeoutMs: 5000,
  }
);

if (!res.ok) {
  // здесь точно не будет повторных попыток
}
*/


/* GET + custom dispatcher

const customAgent = Http.createAgent({
  connections: 10,
});

const res = await Http.get(
  "https://slow.api.example/data",
  {
    dispatcher: customAgent,
    timeoutMs: 10_000,
  }
);

*/

/*
PLain text

const res = await Http.get<string>(
  "https://example.com/robots.txt",
  {
    responseType: "text",
  }
);

if (res.ok) {
  console.log(res.data);
}

*/

/* RAW 
const res = await Http.get(
  "https://example.com/stream",
  {
    responseType: "raw",
  }
);

// body уже “осушено” (dump), сокет не протечёт
*/


/* Allow body on delete 

await Http.delete(
  "https://api.example.com/resource/123",
  {
    allowBody: true,
    body: { reason: "user_request" },
  }
);

}

/* RETRY 502 503 - one time

await Http.get(
  "https://unstable.api.example",
  {
    retry: {
      enabled: true,
      maxAttempts: 2,          // 1 retry
      retryOnStatuses: [502, 503],
    },
  }
);

*/

import { request as undiciRequest, Dispatcher, Agent, errors as UndiciErrors, FormData as UndiciFormData } from "undici";
import diagnosticsChannel from "node:diagnostics_channel";
import { Trace } from "../helper/Trace";
import type { Socket } from "node:net";
import { S_STAT_REGISTRATE_HTTP_REQUEST, S_STAT_REGISTRATE_HTTP_RESULT } from "../MonitorService";
import { LogService } from "../LogService";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type THttpOk<T> = {
  ok: true;
  status: number;
  data: T;
  headers: Record<string, string>;
};

export type THttpErr<E = any> = {
  ok: false;
  status?: number;
  error: E;
  details?: any;
};

export type THttpResult<T, E = any> = THttpOk<T> | THttpErr<E>;

// Outgoing request log entry — mirrors APIServiceNetworkLogItem in spirit.
// Bodies are truncated to the same limits APIService uses for incoming requests.
export type THttpOutgoingLogItem = {
  id: number;
  traceId?: string;       // the incoming request it was made for, when there is one
  created: number;        // unix ms when the request started (first attempt)
  time: number;           // total duration in ms (start → final outcome, including retries)
  method: HttpMethod;
  url: string;
  status?: number;
  ok: boolean;
  attempts: number;       // how many attempts were made (1 = no retries)
  request: any;           // request body, truncated
  response: any;          // response body / error payload, truncated
  error?: string;         // network-level error message if any
  skipLogging?: true;     // made with skipLogging: url is only the origin, bodies and error are not kept
};

// Per-host cumulative statistics — updated on every completed request.
export type THttpHostStats = {
  host: string;              // "api.example.com:443"
  count: number;             // total requests to this host
  errors: number;            // !ok count (non-2xx OR network error)
  timeouts: number;          // subset of errors that were timeouts
  retries: number;           // sum of (attempts - 1) over all requests
  avgMs: number;             // average total duration
  minMs: number;
  maxMs: number;
  p50Ms: number;             // median latency over the last N requests to this host
  p95Ms: number;             // 95th percentile — the tail; watch this grow to catch degradation
  p99Ms: number;             // 99th percentile
  totalTimeMs: number;       // sum, for recomputing avg
  inFlight: number;          // current in-flight requests to this host
  byStatus: {
    s2xx: number;
    s3xx: number;
    s4xx: number;
    s5xx: number;
    other: number;           // non-standard status
    networkErrors: number;   // no HTTP response at all
  };
  lastRequestAt: number;     // unix ms
};

export type THttpStatusDistribution = {
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  other: number;
  networkErrors: number;
  timeouts: number;
};

export type THttpStatsSnapshot = {
  totalRequests: number;
  inFlight: {
    current: number;
    peak: number;
    byHost: Record<string, number>;
  };
  statusDistribution: THttpStatusDistribution;
  perHost: THttpHostStats[];   // sorted by count descending
  topSlow: THttpOutgoingLogItem[];  // sorted by time descending
};

export type TRetryPolicy = {
  enabled?: boolean;
  maxAttempts?: number; // total attempts, incl. first
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOnStatuses?: number[];
  retryOnNetworkErrors?: boolean;
};

export type THttpConfig = {
  baseUrl?: string;

  // Default dispatcher; if omitted, Http will create a shared Agent.
  dispatcher?: Dispatcher;

  timeoutMs?: number;
  headers?: Record<string, string>;
  retry?: TRetryPolicy;

  onRequest?: (ctx: { method: HttpMethod; url: string; attempt: number }) => void;
  onResponse?: (ctx: { method: HttpMethod; url: string; attempt: number; status: number; ms: number }) => void;
  onError?: (ctx: { method: HttpMethod; url: string; attempt: number; ms: number; err: unknown }) => void;
};

export type TRequestOptions = {
  method: HttpMethod;
  url: string; // absolute or relative (if baseUrl is set)

  query?: Record<string, string | number | boolean | null | undefined>;

  headers?: Record<string, string>;
  body?: any;

  timeoutMs?: number;
  dispatcher?: Dispatcher;

  responseType?: "json" | "text" | "raw"; // default "json"
  throwOnJsonParseError?: boolean; // default false

  retry?: TRetryPolicy;

  allowBody?: boolean; // allow body on GET/DELETE if true

  // For URLs that carry a secret (a bot token in the path). The call is still recorded everywhere — the
  // outgoing journal, the slowest calls, the stats — but only as its origin (https://host), marked
  // skipLogging, without path, query, bodies or error text.
  skipLogging?: boolean;
};

type TConnectParams = {
  protocol?: string; // 'https:' | 'http:'
  hostname?: string; // 'api.yapily.com'
  host?: string;     // sometimes present
  port?: string | number; // 443
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function buildQuery(query?: TRequestOptions["query"]) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function mergeHeaders(a?: Record<string, string>, b?: Record<string, string>) {
  return { ...(a || {}), ...(b || {}) };
}

function normalizeHeaders(headers: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;

  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) out[k.toLowerCase()] = v.join(", ");
    else if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function isRetryableStatus(status: number, retryOnStatuses: number[]) {
  return retryOnStatuses.includes(status);
}

// Dual-package hazard guard for FormData:
// Node ships a built-in undici (exposed as the global `fetch`/`FormData`/`Blob`), and this file
// separately imports the `undici` NPM package for the low-level `request()` API. These are two
// different module instances — possibly different versions — even though both implement the
// WHATWG FormData interface. `undici.request()`'s internal body extraction does a WebIDL brand
// check tied to ITS OWN FormData class; a FormData instance from the OTHER copy fails that check
// silently. Symptom observed in production: TCP+TLS complete, but zero bytes ever get written to
// the socket — undici builds an internal stream with no producer and the request just hangs until
// the server's client_body_timeout kills the connection (~60s), surfacing as UND_ERR_SOCKET.
//
// Fix: detect ANY FormData-like object via duck-typing (works across both copies, and across
// unrelated userland FormData polyfills), then re-wrap its entries into an undici-native
// FormData before handing it to `undiciRequest()`. Callers never need to know which FormData
// class to import — `new FormData()` (global) just works.
function isFormDataLike(value: unknown): value is FormData {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.toString.call(value) === "[object FormData]" &&
    typeof (value as any).entries === "function"
  );
}

function normalizeFormData(source: FormData): UndiciFormData {
  // Already the right class — no copying needed.
  if (source instanceof UndiciFormData) return source;

  const target = new UndiciFormData();
  for (const [name, value] of (source as any).entries()) {
    if (typeof value === "string") {
      target.append(name, value);
    } else {
      // Blob/File — carry the filename along if present (File has `.name`; plain Blob doesn't).
      // Passing `undefined` explicitly for the 3rd arg behaves the same as omitting it.
      target.append(name, value, (value as any).name);
    }
  }
  return target;
}

// Case-insensitive Content-Type removal. The exact-key deletes this used to do (`content-type`,
// `Content-Type`) miss variants like `Content-type` or `CONTENT-TYPE` that a caller might have
// set — leaving a stale, boundary-less Content-Type header that breaks multipart parsing on
// the receiving end (a real bug, distinct from the FormData-class hang above).
function removeContentTypeHeader(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") delete headers[key];
  }
}

function isLikelyNetworkError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as any;

  // Abort (timeout)
  if (anyErr?.name === "AbortError") return true;

  // Typical Node/undici network codes
  const code = anyErr?.code as string | undefined;
  const networkCodes = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);
  if (code && networkCodes.has(code)) return true;

  // undici-specific errors (best-effort; class names differ by undici versions)
  if (err instanceof (UndiciErrors as any).ConnectTimeoutError) return true;
  if (err instanceof (UndiciErrors as any).HeadersTimeoutError) return true;
  if (err instanceof (UndiciErrors as any).BodyTimeoutError) return true;
  if (err instanceof (UndiciErrors as any).SocketError) return true;

  return false;
}

export class Http {
  private static _inited = false;

  private static config: THttpConfig = {
    baseUrl: "",
    timeoutMs: 5000,
    headers: {
      accept: "application/json",
    },
    // Off unless a call asks for it: a retried POST can't prove the first attempt did nothing, and
    // for a payment that is a double charge. `retry: { enabled: true }` uses the values below.
    retry: {
      enabled: false,
      maxAttempts: 2,
      baseDelayMs: 200,
      maxDelayMs: 1500,
      retryOnStatuses: [429, 502, 503, 504],
      retryOnNetworkErrors: true,
    },
  };

  // ---- shared Agent (dispatcher) ----
  private static _sharedAgent: Agent | null = null;

  // ---- connection counters (total + per-host) ----
  private static _dcEnabled = false;
  private static _dcConnectedChannel: ReturnType<typeof diagnosticsChannel.channel> | null = null;
  private static _dcListener: ((message: unknown, name: string) => void) | null = null;

  private static _activeConnectionsTotal = 0;
  private static _activeConnectionsByHost = new Map<string, number>();

  private static _countedSockets = new WeakSet<Socket>();
  private static _socketHostKey = new WeakMap<Socket, string>();

  // ---- outgoing request log (ring buffer of last N requests) ----
  private static _outgoingLog: THttpOutgoingLogItem[] = [];
  private static _nextOutgoingLogID = 0;
  private static _outgoingLogLimit = 500;

  // Same rules as APIService's incoming journal: long strings to 255 chars, the payload to 500 — after redaction.
  private static _truncate(v: any): any {
    if (Buffer.isBuffer(v)) return `[Buffer ${v.length} bytes]`;
    return LogService.snapshot(v);   // redacted first, then shortened — same as the incoming journal
  }


  /** "https://api.example.com" of a URL — what a skipLogging call is recorded as. */
  static _origin(url: string): string {
    try { return new URL(url).origin; } catch { return "[url not logged]"; }
  }

  private static _pushOutgoingLog(item: Omit<THttpOutgoingLogItem, "id">): THttpOutgoingLogItem {
    // Redact before storing: bodies are already serialized strings here (see _truncate), so this
    // works on copies and never touches the caller's objects. The URL matters too — outgoing
    // calls routinely carry credentials in the query string.
    const entry: THttpOutgoingLogItem = {
      id: this._nextOutgoingLogID++,
      ...item,
      url: typeof item.url === "string" ? LogService.sanitize(item.url) : item.url,
      request: typeof item.request === "string" ? LogService.sanitize(item.request) : LogService.sanitizeDeep(item.request),
      response: typeof item.response === "string" ? LogService.sanitize(item.response) : LogService.sanitizeDeep(item.response),
      error: typeof item.error === "string" ? LogService.sanitize(item.error) : item.error,
    };
    this._outgoingLog.push(entry);
    if (this._outgoingLog.length > this._outgoingLogLimit)
      this._outgoingLog.shift();
    if (this._nextOutgoingLogID > Number.MAX_SAFE_INTEGER - 1000)
      this._nextOutgoingLogID = 0;
    return entry;
  }

  static getOutgoingLogSnapshot(): THttpOutgoingLogItem[] {
    return this._outgoingLog.slice();
  }

  // ---- aggregate outgoing stats ----
  private static _totalRequests = 0;

  private static _inFlight = 0;
  private static _peakInFlight = 0;
  private static _inFlightByHost = new Map<string, number>();

  private static _statusDist: THttpStatusDistribution = {
    s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, other: 0, networkErrors: 0, timeouts: 0,
  };

  private static _perHost = new Map<string, THttpHostStats>();

  // Top-N slowest requests EVER seen (independent of the 500-entry ring log,
  // so anomalies aren't washed out by high traffic).
  private static _topSlow: THttpOutgoingLogItem[] = [];
  private static _topSlowLimit = 20;

  private static _hostFromUrl(url: string): string {
    try { return new URL(url).host || "unknown"; } catch { return "unknown"; }
  }

  private static _isTimeoutError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as any;
    if (e.name === "AbortError") return true;
    if (typeof e.code === "string" && e.code.includes("TIMEOUT")) return true;
    return false;
  }

  private static _incInFlight(host: string) {
    this._inFlight++;
    if (this._inFlight > this._peakInFlight) this._peakInFlight = this._inFlight;
    this._inFlightByHost.set(host, (this._inFlightByHost.get(host) ?? 0) + 1);
  }

  private static _decInFlight(host: string) {
    this._inFlight = Math.max(0, this._inFlight - 1);
    const prev = this._inFlightByHost.get(host) ?? 0;
    const next = Math.max(0, prev - 1);
    if (next === 0) this._inFlightByHost.delete(host);
    else this._inFlightByHost.set(host, next);
  }

  private static _updateStats(host: string, entry: THttpOutgoingLogItem, isTimeout: boolean) {
    this._totalRequests++;

    // Global status distribution
    if (typeof entry.status === "number") {
      const s = entry.status;
      if (s >= 200 && s < 300) this._statusDist.s2xx++;
      else if (s >= 300 && s < 400) this._statusDist.s3xx++;
      else if (s >= 400 && s < 500) this._statusDist.s4xx++;
      else if (s >= 500 && s < 600) this._statusDist.s5xx++;
      else this._statusDist.other++;
    } else if (entry.error) {
      this._statusDist.networkErrors++;
      if (isTimeout) this._statusDist.timeouts++;
    }

    // Per-host
    let h = this._perHost.get(host);
    if (!h) {
      h = {
        host,
        count: 0, errors: 0, timeouts: 0, retries: 0,
        avgMs: 0, minMs: Infinity, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, totalTimeMs: 0,
        inFlight: 0,
        byStatus: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, other: 0, networkErrors: 0 },
        lastRequestAt: 0,
      };
      this._perHost.set(host, h);
    }
    h.count++;
    h.totalTimeMs += entry.time;
    h.avgMs = Math.round((h.totalTimeMs / h.count) * 10) / 10;
    if (entry.time < h.minMs) h.minMs = entry.time;
    if (entry.time > h.maxMs) h.maxMs = entry.time;
    this._recordLatency(host, entry.time);   // feed the per-host percentile ring
    if (!entry.ok) h.errors++;
    if (isTimeout) h.timeouts++;
    h.retries += Math.max(0, entry.attempts - 1);
    h.lastRequestAt = Date.now();

    if (typeof entry.status === "number") {
      const s = entry.status;
      if (s >= 200 && s < 300) h.byStatus.s2xx++;
      else if (s >= 300 && s < 400) h.byStatus.s3xx++;
      else if (s >= 400 && s < 500) h.byStatus.s4xx++;
      else if (s >= 500 && s < 600) h.byStatus.s5xx++;
      else h.byStatus.other++;
    } else if (entry.error) {
      h.byStatus.networkErrors++;
    }
  }

  // Per-host latency ring buffer for percentiles. Fixed-capacity circular buffer per host so
  // memory is bounded and the percentiles reflect RECENT behaviour (old samples age out) — which
  // is exactly what you want to catch "p95 creeping up over days" without all-time dilution.
  private static _LAT_CAP = 1024;
  private static _latency: Map<string, { s: number[]; pos: number; n: number }> = new Map();

  private static _recordLatency(host: string, ms: number) {
    let r = this._latency.get(host);
    if (!r) { r = { s: new Array(this._LAT_CAP), pos: 0, n: 0 }; this._latency.set(host, r); }
    r.s[r.pos] = ms;
    r.pos = (r.pos + 1) % this._LAT_CAP;
    if (r.n < this._LAT_CAP) r.n++;
  }

  // Nearest-rank percentiles over the buffered samples. Cheap: copies at most _LAT_CAP numbers
  // and sorts, only when getHttpStats() is called (not on the hot request path).
  private static _percentiles(host: string): { p50: number; p95: number; p99: number } {
    const r = this._latency.get(host);
    if (!r || r.n === 0) return { p50: 0, p95: 0, p99: 0 };
    const arr = r.s.slice(0, r.n).sort((a, b) => a - b);
    const pick = (p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1))];
    return { p50: pick(50), p95: pick(95), p99: pick(99) };
  }

  private static _pushToTopSlow(entry: THttpOutgoingLogItem) {
    if (this._topSlow.length < this._topSlowLimit) {
      this._topSlow.push(entry);
      this._topSlow.sort((a, b) => b.time - a.time);
      return;
    }
    const slowest_of_top = this._topSlow[this._topSlow.length - 1];
    if (entry.time > slowest_of_top.time) {
      this._topSlow.push(entry);
      this._topSlow.sort((a, b) => b.time - a.time);
      this._topSlow.pop();
    }
  }

  static getHttpStats(): THttpStatsSnapshot {
    const perHost = Array.from(this._perHost.values())
      .map(h => {
        const p = this._percentiles(h.host);
        return {
          ...h,
          // Don't leak Infinity to JSON (happens if a host has no requests yet, but count check protects us).
          minMs: Number.isFinite(h.minMs) ? h.minMs : 0,
          // Percentiles over the recent per-host ring — the true analog of PM2's "HTTP P95 Latency".
          p50Ms: p.p50, p95Ms: p.p95, p99Ms: p.p99,
          // Live in-flight is stored separately from the accumulator; merge here.
          inFlight: this._inFlightByHost.get(h.host) ?? 0,
        };
      })
      .sort((a, b) => b.count - a.count);

    return {
      totalRequests: this._totalRequests,
      inFlight: {
        current: this._inFlight,
        peak: this._peakInFlight,
        byHost: Object.fromEntries(this._inFlightByHost),
      },
      statusDistribution: { ...this._statusDist },
      perHost,
      topSlow: this._topSlow.slice(),
    };
  }

  private static ensureInit() {
    if (this._inited) return;
    this._inited = true;

    // Enable counters by default (you can disable later)
    this.enableConnectionCounterByHost();

    // Create shared agent if dispatcher not provided
    if (!this.config.dispatcher) {
      this._sharedAgent = this.createAgent({
        connections: 100, // total sockets across all origins (tune as needed)
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 60_000,
      });
      this.config.dispatcher = this._sharedAgent;
    }
  }

  static configure(partial: Partial<THttpConfig>) {
    // merge config (headers + retry merged deeply)
    this.config = {
      ...this.config,
      ...partial,
      headers: mergeHeaders(this.config.headers, partial.headers),
      retry: { ...(this.config.retry || {}), ...(partial.retry || {}) },
    };

    // If user overrides dispatcher, close old shared agent (optional hygiene)
    if (partial.dispatcher && this._sharedAgent) {
      try {
        this._sharedAgent.close();
      } catch {}
      this._sharedAgent = null;
    }

    this.ensureInit();
  }

  static createAgent(opts?: ConstructorParameters<typeof Agent>[0]) {
    return new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 60_000,
      ...opts,
    });
  }

  static closeSharedAgent() {
    if (!this._sharedAgent) return;
    try {
      this._sharedAgent.close();
    } catch {}
    this._sharedAgent = null;

    // Do not null config.dispatcher automatically; user might have set their own dispatcher
    if (this.config.dispatcher === this._sharedAgent) {
      this.config.dispatcher = undefined;
    }
  }

  // ---- auth helpers ----
  static basicAuth(username: string, password: string) {
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    return `Basic ${token}`;
  }

  static bearer(token: string) {
    return `Bearer ${token}`;
  }

  // ---- connection counters: enable/disable ----
  static enableConnectionCounterByHost() {
    if (this._dcEnabled) return;
    this._dcEnabled = true;

    const ch = diagnosticsChannel.channel("undici:client:connected");

    const listener = (message: unknown) => {
      const msg = message as { socket?: Socket; connectParams?: TConnectParams };
      const socket = msg?.socket;
      if (!socket) return;

      // protect from double counting
      if (this._countedSockets.has(socket)) return;
      this._countedSockets.add(socket);

      const key = this._makeHostKey(msg?.connectParams, socket);
      this._socketHostKey.set(socket, key);

      this._activeConnectionsTotal += 1;
      this._activeConnectionsByHost.set(key, (this._activeConnectionsByHost.get(key) ?? 0) + 1);

      const onClose = () => {
        this._activeConnectionsTotal = Math.max(0, this._activeConnectionsTotal - 1);

        const k = this._socketHostKey.get(socket) ?? "unknown://unknown:0";
        const prev = this._activeConnectionsByHost.get(k) ?? 0;
        const next = Math.max(0, prev - 1);

        if (next === 0) this._activeConnectionsByHost.delete(k);
        else this._activeConnectionsByHost.set(k, next);

        socket.off("close", onClose);
      };

      socket.on("close", onClose);
    };

    ch.subscribe(listener);

    this._dcConnectedChannel = ch;
    this._dcListener = listener as any;
  }

  static disableConnectionCounterByHost(options?: { reset?: boolean }) {
    if (!this._dcEnabled) return;

    const ch = this._dcConnectedChannel;
    const listener = this._dcListener;

    if (ch && listener) {
      // @ts-expect-error deprecated in types, used intentionally
      ch.unsubscribe(listener);
    }

    this._dcConnectedChannel = null;
    this._dcListener = null;
    this._dcEnabled = false;

    if (options?.reset) {
      this._activeConnectionsTotal = 0;
      this._activeConnectionsByHost.clear();
      // WeakSet/WeakMap cannot be "cleared"—recreate if you need a hard reset
      this._countedSockets = new WeakSet<Socket>();
      this._socketHostKey = new WeakMap<Socket, string>();
    }
  }

  private static _makeHostKey(connectParams?: TConnectParams, socket?: Socket): string {
    const protocolRaw = connectParams?.protocol || "unknown:";
    const protocol = protocolRaw.replace(/\/+$/g, "");
    const hostname = connectParams?.hostname || connectParams?.host;

    let port = connectParams?.port !== undefined && connectParams?.port !== null ? String(connectParams.port) : undefined;
    if (!port) {
      if (protocol === "https:") port = "443";
      else if (protocol === "http:") port = "80";
      else port = "?";
    }

    // Full key with protocol + host + port (as you requested)
    if (hostname) return `${protocol}//${hostname}:${port}`;

    // fallback if connectParams absent
    const addr = (socket as any)?.remoteAddress ?? "unknown";
    const p = (socket as any)?.remotePort ?? "?";
    return `${protocol}//${addr}:${p}`;
  }

  static getActiveConnectionsTotal() {
    return this._activeConnectionsTotal;
  }

  static getActiveConnectionsByHost() {
    return new Map(this._activeConnectionsByHost);
  }

  static getActiveConnectionsSnapshot(): { total: number; byHost: Record<string, number> } {
    return {
      total: this._activeConnectionsTotal,
      byHost: Object.fromEntries(this._activeConnectionsByHost.entries()),
    };
  }

  // ---- main request ----
  static async request<T = any, E = any>(opts: TRequestOptions): Promise<THttpResult<T, E>> {

    S_STAT_REGISTRATE_HTTP_REQUEST.invoke({url: opts.skipLogging ? Http._origin(opts.url) : opts.url});

    this.ensureInit();

    const overallStarted = Date.now();
    const cfg = this.config;

    const retryCfg: Required<TRetryPolicy> = {
      enabled: opts.retry?.enabled ?? cfg.retry?.enabled ?? false,
      maxAttempts: opts.retry?.maxAttempts ?? cfg.retry?.maxAttempts ?? 2,
      baseDelayMs: opts.retry?.baseDelayMs ?? cfg.retry?.baseDelayMs ?? 200,
      maxDelayMs: opts.retry?.maxDelayMs ?? cfg.retry?.maxDelayMs ?? 1500,
      retryOnStatuses: opts.retry?.retryOnStatuses ?? cfg.retry?.retryOnStatuses ?? [429, 502, 503, 504],
      retryOnNetworkErrors: opts.retry?.retryOnNetworkErrors ?? cfg.retry?.retryOnNetworkErrors ?? true,
    };

    const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs ?? 5000;
    const dispatcher = opts.dispatcher ?? cfg.dispatcher; // shared Agent by default

    const baseUrl = cfg.baseUrl || "";
    const isAbsolute = /^https?:\/\//i.test(opts.url);
    const query = buildQuery(opts.query);
    const url = (isAbsolute ? opts.url : baseUrl + opts.url) + query;

    const headers = mergeHeaders(cfg.headers, opts.headers);

    // Body handling
    let body: any = undefined;
    const hasBody = opts.body !== undefined && opts.body !== null;
    const allowBody = opts.allowBody ?? (opts.method !== "GET" && opts.method !== "DELETE");

    // Set when the outgoing body is multipart/form-data — used below both to skip the
    // JSON-stringify path and to force retries off (see retryCfg.maxAttempts override).
    let isMultipart = false;

    if (hasBody && allowBody) {
      // FormData (from ANY implementation — global Node FormData, the undici package's own,
      // or a userland polyfill): re-wrap into undici's own FormData class before handing it to
      // undiciRequest(). See normalizeFormData()'s comment for why this matters — without it,
      // a cross-copy FormData silently hangs the request (0 bytes written, ~60s timeout).
      // undici serializes the result to multipart/form-data and sets Content-Type with the
      // correct boundary itself; any pre-set Content-Type (any casing) would strip the boundary
      // and break parsing server-side, so we clear it explicitly.
      if (isFormDataLike(opts.body)) {
        isMultipart = true;
        body = normalizeFormData(opts.body);
        removeContentTypeHeader(headers);
      } else {
        const ct = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
        if (!ct) headers["content-type"] = "application/json";

        const ct2 = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
        if (ct2.includes("application/json") && typeof opts.body !== "string" && !(opts.body instanceof Buffer)) {
          body = JSON.stringify(opts.body);
        } else {
          body = opts.body;
        }
      }
    }

    // Never retry multipart/form-data requests, regardless of caller-supplied retry config.
    // Reasoning: a retried POST can't prove the server didn't already process the first attempt
    // (upload/payment/KYC-document endpoints are exactly the non-idempotent case this bites);
    // and some FormData sources (arbitrary Readable/async-iterable parts) can only be read once —
    // a second attempt would send empty/broken data even if the server-side risk were acceptable.
    if (isMultipart && retryCfg.maxAttempts !== 1) {
      retryCfg.maxAttempts = 1;
    }

    const responseType = opts.responseType ?? "json";
    const throwOnJsonParseError = opts.throwOnJsonParseError ?? false;

    // Tracks the latest attempt number so `finish` can report it after the loop exits.
    let attemptsMade = 0;

    // Compute host once and register in-flight before any awaited work.
    const host = Http._hostFromUrl(url);
    const traceId = Trace.current() ?? undefined;   // the incoming request this call was made for
    Http._incInFlight(host);

    // Single point that pushes to the outgoing log, updates aggregate stats, and returns the result.
    // Captures total request duration (start of first attempt → final outcome, retries included).
    const finish = (result: THttpResult<T, E>, networkErr?: unknown): THttpResult<T, E> => {
      Http._decInFlight(host);
      const item = {
        traceId,
        created: overallStarted,
        time: Date.now() - overallStarted,
        method: opts.method,
        url,
        status: (result as any).status,
        ok: result.ok,
        attempts: attemptsMade,
        request: Http._truncate(opts.body),
        response: Http._truncate(result.ok ? (result as THttpOk<T>).data : (result as THttpErr<E>).error),
        error: networkErr ? String((networkErr as any)?.message ?? networkErr) : undefined,
      };
      // skipLogging: the call is recorded, but only as its origin — what was sent and answered is not kept.
      const entry = Http._pushOutgoingLog(opts.skipLogging
        ? { ...item, url: Http._origin(url), request: "[not logged]", response: "[not logged]",
            error: networkErr ? (Http._isTimeoutError(networkErr) ? "timeout" : "network error") : undefined, skipLogging: true }
        : item);
      const isTimeout = Http._isTimeoutError(networkErr);
      Http._updateStats(host, entry, isTimeout);
      Http._pushToTopSlow(entry);
      // Feed the per-minute stat slots: outbound success/fail + latency per host (for the
      // "outbound over time" and "p95 over time" charts). Fired on completion (start-time
      // S_STAT_REGISTRATE_HTTP_REQUEST only knows the url, not the outcome).
      S_STAT_REGISTRATE_HTTP_RESULT.invoke({ host, ok: result.ok, ms: entry.time });
      return result;
    };

    for (let attempt = 1; attempt <= retryCfg.maxAttempts; attempt++) {
      attemptsMade = attempt;
      const started = Date.now();
      cfg.onRequest?.({ method: opts.method, url, attempt });

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await undiciRequest(url, {
          method: opts.method,
          headers,
          body,
          signal: controller.signal,
          dispatcher,
        });

        const ms = Date.now() - started;
        const status = res.statusCode;
        cfg.onResponse?.({ method: opts.method, url, attempt, status, ms });

        const hdrs = normalizeHeaders(res.headers);

        // Read body
        let parsed: any = undefined;
        let rawText: string | undefined;

        if (responseType === "raw") {
          // drain to avoid socket leaks
          await res.body.dump();
          parsed = undefined;
        } else if (responseType === "text") {
          rawText = await res.body.text();
          parsed = rawText;
        } else {
          rawText = await res.body.text(); // read once, then parse
          if (rawText.length === 0) {
            parsed = null;
          } else {
            try {
              parsed = JSON.parse(rawText);
            } catch (e) {
              if (throwOnJsonParseError) throw e;
              parsed = rawText; // keep raw for diagnostics
            }
          }
        }

        if (status >= 200 && status < 300) {
          return finish({ ok: true, status, data: parsed as T, headers: hdrs });
        }

        // Non-2xx response; decide retry
        const retryable =
          retryCfg.enabled &&
          isRetryableStatus(status, retryCfg.retryOnStatuses) &&
          attempt < retryCfg.maxAttempts;

        if (retryable) {
          const backoff = clamp(
            retryCfg.baseDelayMs * Math.pow(2, attempt - 1),
            retryCfg.baseDelayMs,
            retryCfg.maxDelayMs
          );
          await sleep(backoff);
          continue;
        }

        return finish({ ok: false, status, error: parsed as any as E, details: { headers: hdrs } });
      } catch (err) {
        const ms = Date.now() - started;
        cfg.onError?.({ method: opts.method, url, attempt, ms, err });

        const retryable =
          retryCfg.enabled &&
          retryCfg.retryOnNetworkErrors &&
          isLikelyNetworkError(err) &&
          attempt < retryCfg.maxAttempts;

        if (retryable) {
          const backoff = clamp(
            retryCfg.baseDelayMs * Math.pow(2, attempt - 1),
            retryCfg.baseDelayMs,
            retryCfg.maxDelayMs
          );
          await sleep(backoff);
          continue;
        }

        return finish({ ok: false, error: err as any as E, details: { network: true } }, err);
      } finally {
        clearTimeout(t);
      }
    }

    return finish({ ok: false, error: "UNKNOWN" as any });
  }

  // ---- convenience methods ----
  static get<T = any, E = any>(url: string, opts?: Omit<TRequestOptions, "method" | "url">) {
    return this.request<T, E>({ ...(opts || {}), method: "GET", url });
  }

  static post<T = any, E = any>(url: string, body?: any, opts?: Omit<TRequestOptions, "method" | "url" | "body">) {
    return this.request<T, E>({ ...(opts || {}), method: "POST", url, body });
  }

  static put<T = any, E = any>(url: string, body?: any, opts?: Omit<TRequestOptions, "method" | "url" | "body">) {
    return this.request<T, E>({ ...(opts || {}), method: "PUT", url, body });
  }

  static patch<T = any, E = any>(url: string, body?: any, opts?: Omit<TRequestOptions, "method" | "url" | "body">) {
    return this.request<T, E>({ ...(opts || {}), method: "PATCH", url, body });
  }

  static delete<T = any, E = any>(url: string, opts?: Omit<TRequestOptions, "method" | "url">) {
    return this.request<T, E>({ ...(opts || {}), method: "DELETE", url });
  }
}
