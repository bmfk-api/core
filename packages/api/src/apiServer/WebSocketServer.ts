
import { Signal } from "../signal/Signal";
import WebSocket from "ws";
import { IncomingMessage } from "http";
import { logError, logWarn } from "./LogService";

// Fired once a connection has passed authorization — never for one still waiting or refused.
export const S_WS_ON_CONNECTED = new Signal<WebSocketConnection>("S_WS_ON_CONNECTED");
// Every message after authorization. JSON is parsed; other text arrives as a string, binary as a Buffer.
export const S_WS_ON_MESSAGE = new Signal<{ connection: WebSocketConnection, message: any }>("S_WS_ON_MESSAGE");
// Fired only for connections that were announced by S_WS_ON_CONNECTED.
export const S_WS_ON_CLOSE = new Signal<WebSocketConnection>("S_WS_ON_CLOSE");

// Close codes the client can act on (4xxx is the application range of RFC 6455).
export const WS_CLOSE_UNAUTHORIZED = 4401;   // credentials refused — don't retry with the same ones
export const WS_CLOSE_AUTH_TIMEOUT = 4408;   // no (or too slow) authorization
export const WS_CLOSE_RATE_LIMIT = 1008;
export const WS_CLOSE_INTERNAL = 1011;

// Receives the client's first message (parsed like any other) and decides.
// false/null/undefined → refused; true → accepted; anything else → accepted and kept as connection.auth.
export type WebSocketAuthorizer = (connection: WebSocketConnection, message: any) => Promise<any> | any;

export interface IWebSocketConnectionOptions {
    authTimeoutMs: number
    maxMessagesPerSecond: number
}

var WS_NEXT_ID = 1;
export class WebSocketConnection {
    authorized: boolean = false;
    auth: any = undefined;          // what onAuthorize returned (when it returned more than true)
    ws: WebSocket;
    id: number;
    ip: string;
    req: IncomingMessage;           // the handshake request (headers, url)
    connectedAt = Date.now();

    constructor(ws: WebSocket, req: IncomingMessage, ip: string) {
        this.ws = ws;
        this.req = req;
        this.ip = ip;
        this.id = WS_NEXT_ID++;
    }

    get isOpen(): boolean {
        return this.ws.readyState === WebSocket.OPEN;
    }

    // Objects go as JSON. Returns false when the socket is no longer open.
    send(data: any): boolean {
        if (!this.isOpen) return false;
        const payload = typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data);
        this.ws.send(payload, err => { if (err) logWarn(`WebSocket ${this.id}: send failed — ${err.message}`); });
        return true;
    }

    close(code = 1000, reason = "") {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
            this.ws.close(code, reason);
    }
}

export class WebSocketServer {
    #onAuthorize: WebSocketAuthorizer | null;
    #options: IWebSocketConnectionOptions;
    connections: WebSocketConnection[] = [];   // authorized only

    constructor(onAuthorize: WebSocketAuthorizer | null, options: IWebSocketConnectionOptions) {
        this.#onAuthorize = onAuthorize;
        this.#options = options;
    }

    // Takes over a socket right after the handshake. The client must authorize with its first
    // message within authTimeoutMs — counted until onAuthorize answers, so a slow check is
    // dropped too. Messages sent while the check runs are discarded.
    accept(ws: WebSocket, req: IncomingMessage, ip: string) {
        const connection = new WebSocketConnection(ws, req, ip);

        // Installed before anything can fail: an "error" with no listener crashes the process.
        ws.on("error", err => logWarn(`WebSocket ${connection.id} (${ip}): ${err.message}`));
        this.#limitMessageRate(connection);

        let stage: "waiting" | "checking" | "done" = "waiting";
        const timer = setTimeout(() => {
            if (stage === "done") return;
            stage = "done";
            logWarn(`WebSocket ${connection.id} (${ip}) closed: not authorized within ${this.#options.authTimeoutMs} ms`);
            connection.close(WS_CLOSE_AUTH_TIMEOUT, "Authorization timeout");
        }, this.#options.authTimeoutMs);

        ws.on("close", () => {
            clearTimeout(timer);
            stage = "done";
            if (!connection.authorized) return;
            connection.authorized = false;
            this.connections = this.connections.filter(c => c !== connection);
            this.#invoke(S_WS_ON_CLOSE, connection);
        });

        ws.on("message", async (data, isBinary) => {
            const message = WebSocketServer.parse(data, isBinary);
            if (connection.authorized) {
                this.#invoke(S_WS_ON_MESSAGE, { connection, message });
                return;
            }
            if (stage !== "waiting") return;
            stage = "checking";

            let result: any;
            try {
                result = this.#onAuthorize ? await this.#onAuthorize(connection, message) : true;
            } catch (e) {
                if (stage !== "checking") return;
                stage = "done";
                clearTimeout(timer);
                logError(`WebSocket ${connection.id} (${ip}): onAuthorize threw — ${e instanceof Error ? e.message : String(e)}`);
                connection.close(WS_CLOSE_INTERNAL, "Authorization failed");
                return;
            }
            // Timed out or the client left while we were checking: the verdict no longer matters.
            if (stage !== "checking" || !connection.isOpen) return;
            stage = "done";
            clearTimeout(timer);

            if (result === false || result === null || result === undefined) {
                logWarn(`WebSocket ${connection.id} (${ip}) refused: unauthorized`);
                connection.close(WS_CLOSE_UNAUTHORIZED, "Unauthorized");
                return;
            }
            connection.authorized = true;
            if (result !== true) connection.auth = result;
            this.connections.push(connection);
            this.#invoke(S_WS_ON_CONNECTED, connection);
        });

        // No authorizer: a public socket, nothing to wait for.
        if (!this.#onAuthorize) {
            stage = "done";
            clearTimeout(timer);
            connection.authorized = true;
            this.connections.push(connection);
            this.#invoke(S_WS_ON_CONNECTED, connection);
        }
    }

    // Send to every authorized connection (or those matching filter). Returns how many got it.
    broadcast(data: any, filter?: (c: WebSocketConnection) => boolean): number {
        let n = 0;
        for (const c of this.connections)
            if ((!filter || filter(c)) && c.send(data)) n++;
        return n;
    }

    static parse(data: WebSocket.RawData, isBinary: boolean): any {
        if (isBinary) return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as any);
        const text = data.toString();
        try { return JSON.parse(text); } catch { return text; }
    }

    // A throwing subscriber must not break the socket handling (or other subscribers' delivery).
    #invoke<T>(signal: Signal<T>, data: T) {
        try { signal.invoke(data); }
        catch (e) { logError(`WebSocket signal handler threw: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Fixed one-second window per connection. Frames already buffered keep arriving after
    // close(), so over-limit messages are dropped at emit — nobody downstream sees them.
    #limitMessageRate(connection: WebSocketConnection) {
        const ws = connection.ws, max = this.#options.maxMessagesPerSecond;
        let windowStart = Date.now(), count = 0, over = false;
        const emit = ws.emit.bind(ws);
        ws.emit = ((event: string | symbol, ...args: any[]) => {
            if (event !== "message") return emit(event, ...args);
            if (over) return false;
            const now = Date.now();
            if (now - windowStart >= 1000) { windowStart = now; count = 0; }
            if (++count > max) {
                over = true;
                logWarn(`WebSocket ${connection.id} (${connection.ip}) closed: over ${max} messages/s`);
                connection.close(WS_CLOSE_RATE_LIMIT, "Rate limit exceeded");
                return false;
            }
            return emit(event, ...args);
        }) as typeof ws.emit;
    }
}
