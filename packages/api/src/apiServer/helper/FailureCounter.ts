// Failed sign-ins per login: `max` failures lock the login for `lockMs`; failures older than `lockMs`
// are forgotten. Bounded: sign-ins with random logins can't grow it past `cap` (oldest unlocked
// entries go first).
export class FailureCounter {
    private entries = new Map<string, { count: number, lockedUntil: number, lastAt: number }>();

    constructor(private max: number, private lockMs: number, private cap = 10_000) {}

    lockedFor(login: string, now = Date.now()): number {
        const e = this.entries.get(login);
        return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
    }

    fail(login: string, now = Date.now()) {
        let e = this.entries.get(login);
        if (e && e.lockedUntil <= now && now - e.lastAt > this.lockMs) e = undefined;
        e = e ?? { count: 0, lockedUntil: 0, lastAt: now };
        e.count++;
        e.lastAt = now;
        if (e.count >= this.max) { e.lockedUntil = now + this.lockMs; e.count = 0; }
        this.entries.delete(login);   // re-inserted: the map stays in last-failure order
        this.entries.set(login, e);
        this.prune(now);
    }

    clear(login: string) { this.entries.delete(login); }

    get size(): number { return this.entries.size; }

    private prune(now: number) {
        if (this.entries.size <= this.cap) return;
        for (const [k, e] of this.entries) {
            if (this.entries.size <= this.cap) return;
            if (e.lockedUntil <= now) this.entries.delete(k);
        }
        for (const k of this.entries.keys()) {
            if (this.entries.size <= this.cap) return;
            this.entries.delete(k);
        }
    }
}
