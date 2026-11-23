// Signals and requests connect services without importing each other.
// This file imports nothing from the rest of the library, so it can later move into its own package.

type Subscriber<T> = { cb: (data: T) => void; id: string };

/**
 * One-to-many notification.
 *
 *   export const S_ORDER_PAID = new Signal<Order>("S_ORDER_PAID");
 *   const id = S_ORDER_PAID.subscribe(order => …);
 *   S_ORDER_PAID.invoke(order);
 *   S_ORDER_PAID.unsubscribe(id);
 *
 * - Subscribers run synchronously, in the order they subscribed.
 * - A subscriber that throws does not stop the others or break the signal: the error goes to
 *   `Signal.onError` (stderr by default) and the next subscriber runs.
 * - Changes made while the signal is running apply from the next invoke: a new subscriber is not
 *   called in the current one, a removed one still is.
 * - An invoke from inside a subscriber is queued and runs after the current one, in order.
 */
export class Signal<T> {
    private static nextID = 0;

    /** Where errors thrown by subscribers go. Must not throw. */
    static onError: (signal: Signal<any>, error: unknown) => void = (signal, error) => {
        try { console.error(`Signal ${signal.name}: a subscriber threw`, error); } catch { }
    };

    readonly name: string;
    private subscribers: Subscriber<T>[] = [];
    private queue: T[] = [];
    private running = false;

    constructor(name?: string) {
        this.name = name || "S_" + Signal.nextID++;
    }

    /** Adds a subscriber and returns its id. The same callback subscribed again keeps its first id. */
    subscribe(callback: (data: T) => void, id?: string): string {
        const existing = this.subscribers.find(s => s.cb === callback);
        if (existing) return existing.id;
        const subscriber = { cb: callback, id: id ?? "" + Signal.nextID++ };
        this.subscribers = [...this.subscribers, subscriber];
        return subscriber.id;
    }

    /** Removes the subscriber with this id. Returns false when there is none. */
    unsubscribe(id: string): boolean {
        const before = this.subscribers.length;
        this.subscribers = this.subscribers.filter(s => s.id !== id);
        return this.subscribers.length < before;
    }

    removeAll(): void {
        this.subscribers = [];
    }

    get size(): number {
        return this.subscribers.length;
    }

    invoke(data: T): void {
        this.queue.push(data);
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length) {
                const next = this.queue.shift() as T;
                // subscribe/unsubscribe replace the array, so this pass keeps the list it started with
                for (const s of this.subscribers) {
                    try {
                        s.cb(next);
                    } catch (e) {
                        try { Signal.onError(this, e); } catch { }
                    }
                }
            }
        } finally {
            this.running = false;
        }
    }
}

/**
 * Request/response between services: one worker answers, any number of callers ask.
 *
 *   export const REQ_RATE = new Req<string, number>(undefined, "REQ_RATE");
 *   REQ_RATE.listener = async currency => …;      // in the service that knows
 *   const rate = await REQ_RATE.request("EUR");    // anywhere
 */
export class Req<T, K> {
    private static nextID = 1;

    readonly name: string;
    private worker?: (request: T) => Promise<K>;

    constructor(worker?: (request: T) => Promise<K>, name?: string) {
        this.name = name || "Req_" + Req.nextID++;
        this.worker = worker;
    }

    /** Sets the worker; a later assignment replaces it. */
    set listener(worker: (request: T) => Promise<K>) {
        this.worker = worker;
    }

    get hasListener(): boolean {
        return this.worker !== undefined;
    }

    /** Rejects (never throws synchronously) when no worker is set or the worker throws. */
    async request(data: T): Promise<K> {
        if (!this.worker)
            throw new Error(`No worker registered in ${this.name}`);
        return this.worker(data);
    }
}
