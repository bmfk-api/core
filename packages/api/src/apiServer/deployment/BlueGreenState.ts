// App-side answer to "is the slot I'm running in the live one?".
//
// The deployer writes BLUEGREEN_FILE into every blue-green slot directory on deploy:
//   { version, project, slot, statusUrl, token, writtenAt }
// where `token` is a read-only per-project status token (NOT the deploy token or deployer
// credentials) and `statusUrl` points at the deployer's pckg/slot endpoint — on loopback by
// default, since the deployer always runs on the same host as the apps it deploys.
//
// getBlueGreenActiveState() locates that file next to the running entry script, asks the deployer,
// caches the answer, and never throws: failures come back in `error` with isActive = null.

import fs from "fs";
import path from "path";
import { Signal } from "../../signal/Signal";

export const BLUEGREEN_FILE = ".bluegreen.json";

export type TSlot = "blue" | "green";

export interface IBlueGreenState {
    // THE field to branch on: should this process act as the live instance (run crons, mailers,
    // singleton jobs)? Not blue-green → true (a single deployment is always live). Blue-green →
    // isActive. null only while unknown (no answer from the deployer yet) — wait, don't guess.
    // Code written against `live` works unchanged before and after a project moves to blue-green.
    live: boolean | null;
    bluegreen: boolean;            // false → this process wasn't deployed as a blue-green slot
    project: string | null;
    slot: TSlot | null;            // which slot THIS process runs in
    active: TSlot | null;          // deployer's current live slot (null if unknown)
    isActive: boolean | null;      // slot === active; null when it couldn't be determined
    lastDeployed: TSlot | null;    // slot of the most recent deploy (may not be switched yet)
    readyToSwitch: boolean | null; // lastDeployed !== active → a deployed slot awaits activation
    checkedAt: number;             // when the deployer was actually asked (unix ms)
    cached: boolean;               // true if served from cache without asking the deployer
    stale?: boolean;               // sync getter only: the latest check failed, values are the
                                   // last known good ones (error says why)
    error?: string;                // set when the file is broken or the deployer can't answer
}

// Fired when this process's blue-green standing changes (isActive or active slot), and once with
// the first known state (previous = null). NOT fired when a failed check merely holds the last
// known value. Typical use: start/stop singleton work (crons, mailers) on the live slot only.
export const S_BLUEGREEN_STATE_CHANGED = new Signal<{ current: IBlueGreenState; previous: IBlueGreenState | null }>();

export interface IBlueGreenStateOptions {
    force?: boolean;   // bypass the cache
    ttlMs?: number;    // cache lifetime, default 10s (errors are cached too, so a down deployer
                       // doesn't make every caller wait for the timeout)
    timeoutMs?: number;// deployer request timeout, default 3s
}

type TBlueGreenFile = { project: string; slot: TSlot; statusUrl: string; token: string };

let cache: { at: number; value: IBlueGreenState } | null = null;
let inflight: Promise<IBlueGreenState> | null = null;
let lastKnown: IBlueGreenState | null = null;     // sticky value behind the sync getter
let watchTimer: NodeJS.Timeout | null = null;

// Single place every fresh check lands: applies "hold last known on failure" and emits the change
// signal. A failed check (isActive === null) never overwrites a previously determined answer —
// a deployer blip must not flip the app into "standby" and stop its crons.
function remember(fresh: IBlueGreenState) {
    const previous = lastKnown;
    if (fresh.live === null && previous && previous.live !== null && fresh.bluegreen) {
        lastKnown = { ...previous, checkedAt: fresh.checkedAt, stale: true, error: fresh.error };
        return;
    }
    lastKnown = { ...fresh, cached: false, stale: false };
    if (!previous || previous.live !== lastKnown.live || previous.isActive !== lastKnown.isActive
        || previous.active !== lastKnown.active) {
        try { S_BLUEGREEN_STATE_CHANGED.invoke({ current: lastKnown, previous }); } catch { /* subscriber errors are theirs */ }
    }
}

/**
 * Run `cb(live)` now if the answer is already known, then again only when `live` flips.
 * Never called with an unknown value — before the first answer the callback just waits.
 * Race-free regardless of whether you subscribe before or after the first check.
 * Returns an unsubscribe function.
 *
 *   onLiveChange(live => live ? startCrons() : stopCrons());
 *
 * Not blue-green → fires once with true (and never again). Blue-green → true on the active slot,
 * false on standby, re-fired on every switch.
 */
export function onLiveChange(cb: (live: boolean, state: IBlueGreenState) => void): () => void {
    let delivered: boolean | null = null;
    const deliver = (s: IBlueGreenState | null) => {
        if (!s || s.live === null || s.live === delivered) return;
        delivered = s.live;
        try { cb(s.live, s); } catch { /* subscriber errors are theirs */ }
    };
    const id = S_BLUEGREEN_STATE_CHANGED.subscribe(({ current }) => deliver(current));
    deliver(lastKnown);
    return () => { S_BLUEGREEN_STATE_CHANGED.unsubscribe(id); };
}

/** Last known state without any I/O (null until the first check completes). See remember(). */
export function getBlueGreenStateSync(): IBlueGreenState | null {
    return lastKnown;
}

/**
 * Background refresh so hot paths can use the sync getter instead of awaiting the deployer.
 * Unref'd timer (never keeps the process alive). Stops by itself when the app turns out not to be
 * a blue-green slot — the file can't appear without a redeploy, which restarts the process.
 */
export function startBlueGreenWatcher(intervalMs = 5000) {
    if (watchTimer || intervalMs <= 0) return;
    const tick = async () => {
        const s = await getBlueGreenActiveState({ force: true });
        if (!s.bluegreen) stopBlueGreenWatcher();
    };
    watchTimer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    watchTimer.unref?.();
    tick().catch(() => {});   // first check right away
}

export function stopBlueGreenWatcher() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
}

// Search upward from the entry script's directory (bin/index.js → slot root). Deliberately NOT
// from process.cwd(): under pm2 the cwd can be the deployer's own directory, which — if the
// deployer itself was deployed blue-green — would hold ITS file and yield a wrong answer.
// BLUEGREEN_FILE env var overrides the lookup (absolute path).
function findFile(): string | null {
    const override = process.env.BLUEGREEN_FILE;
    if (override) return fs.existsSync(override) ? override : null;

    const main = require.main?.filename ?? process.argv[1];
    if (!main) return null;

    let dir = path.dirname(path.resolve(main));
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, BLUEGREEN_FILE);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function readFile(file: string): TBlueGreenFile | null {
    try {
        const j = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (j && typeof j.project === "string" && (j.slot === "blue" || j.slot === "green")
            && typeof j.statusUrl === "string" && typeof j.token === "string")
            return j;
    } catch { /* fall through */ }
    return null;
}

async function query(timeoutMs: number): Promise<IBlueGreenState> {
    // Not blue-green (no file): the one and only deployment — always live.
    const base: IBlueGreenState = {
        live: true, bluegreen: false, project: null, slot: null, active: null, isActive: null,
        lastDeployed: null, readyToSwitch: null, checkedAt: Date.now(), cached: false,
    };

    const file = findFile();
    if (!file) return base;

    // A file exists → this IS meant to be a blue-green slot. If it's broken we can't tell which
    // slot we are, so `live` is unknown (null) rather than "true": guessing live here could run
    // singleton jobs twice alongside the real live slot.
    const cfg = readFile(file);
    if (!cfg) return { ...base, live: null, bluegreen: true, error: `${BLUEGREEN_FILE} at ${file} is unreadable or malformed` };

    const known: IBlueGreenState = { ...base, live: null, bluegreen: true, project: cfg.project, slot: cfg.slot };
    try {
        const res = await fetch(cfg.statusUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: cfg.project, token: cfg.token, slot: cfg.slot }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body: any = await res.json().catch(() => null);
        const d = body?.data;
        if (!res.ok || body?.error || !d) {
            const reason = body?.error?.message ?? `HTTP ${res.status}`;
            return { ...known, error: `deployer rejected the status query: ${reason}` };
        }
        const slotOrNull = (v: any): TSlot | null => (v === "blue" || v === "green" ? v : null);
        const active = slotOrNull(d.active);
        return {
            ...known,
            live: active ? active === cfg.slot : null,
            active,
            lastDeployed: slotOrNull(d.lastDeployed),
            readyToSwitch: typeof d.readyToSwitch === "boolean" ? d.readyToSwitch : null,
            isActive: active ? active === cfg.slot : null,
        };
    } catch (e: any) {
        return { ...known, error: `deployer unreachable at ${cfg.statusUrl}: ${e?.message ?? e}` };
    }
}

export async function getBlueGreenActiveState(opts?: IBlueGreenStateOptions): Promise<IBlueGreenState> {
    const ttl = opts?.ttlMs ?? 10_000;
    if (!opts?.force && cache && Date.now() - cache.at < ttl)
        return { ...cache.value, cached: true };

    // Concurrent callers share one in-flight request instead of stampeding the deployer.
    if (inflight) return inflight;
    // The async call returns the RAW result of this check (isActive may be null on failure);
    // the sticky last-known value lives behind getBlueGreenStateSync().
    inflight = query(opts?.timeoutMs ?? 3000)
        .then(value => { cache = { at: Date.now(), value }; remember(value); return value; })
        .finally(() => { inflight = null; });
    return inflight;
}
