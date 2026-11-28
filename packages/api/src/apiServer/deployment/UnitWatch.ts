// Crash alerts for processes under systemd. systemd restarts a crashed app by itself (Restart=always),
// silently; the deployer's Watchdog polls the units and tells people (Telegram, email) when:
//
//   - an app crashed and was restarted      (NRestarts went up)
//   - an app is in a crash loop / failed    (ActiveState became failed)
//   - an app came back after failing        (failed → running)
//
// A stop by `bmfk ps stop` (inactive) is a decision, not an incident: no alert. Restarts are reported
// at most once per unit per QUIET_MS, with the count, so a flapping app doesn't flood the chat.

import { IUnitState } from "./Ps";

export type UnitEventKind = "crashed" | "failed" | "recovered";
export interface IUnitEvent { unit: string; kind: UnitEventKind; restarts: number; text: string }

export const QUIET_MS = 5 * 60_000;

export class UnitWatch {
    private last = new Map<string, IUnitState>();
    private lastCrashAlert = new Map<string, number>();
    private pendingCrashes = new Map<string, number>();

    // Feed the states of one poll; get what to tell people.
    next(states: Map<string, IUnitState>, now = Date.now()): IUnitEvent[] {
        const out: IUnitEvent[] = [];
        for (const [unit, s] of states) {
            const prev = this.last.get(unit);
            const failed = s.activeState === "failed";
            const running = s.activeState === "active" && s.subState === "running";
            const restarts = s.restarts ?? 0;

            if (!prev) {
                // First sight (deployer start, or a new unit): only a failure is news.
                if (failed) out.push(this.failedEvent(unit, s));
                continue;
            }

            const wasFailed = prev.activeState === "failed";
            if (failed && !wasFailed) out.push(this.failedEvent(unit, s));
            else if (running && wasFailed) out.push({ unit, kind: "recovered", restarts, text: "running again" });

            // NRestarts counts automatic restarts. A drop means a manual (re)start reset it.
            const added = prev.restarts !== null && s.restarts !== null && s.restarts > prev.restarts ? s.restarts - prev.restarts : 0;
            if (added && !failed) {
                const pending = (this.pendingCrashes.get(unit) ?? 0) + added;
                const lastAt = this.lastCrashAlert.get(unit) ?? 0;
                if (now - lastAt >= QUIET_MS) {
                    out.push({ unit, kind: "crashed", restarts, text: `error: crashed and was restarted by systemd${pending > 1 ? ` (${pending} times)` : ""}` });
                    this.lastCrashAlert.set(unit, now);
                    this.pendingCrashes.delete(unit);
                } else this.pendingCrashes.set(unit, pending);
            }
        }
        for (const u of [...this.last.keys()]) if (!states.has(u)) { this.last.delete(u); this.pendingCrashes.delete(u); }
        for (const [u, s] of states) this.last.set(u, s);
        return out;
    }

    private failedEvent(unit: string, s: IUnitState): IUnitEvent {
        const loop = s.result === "start-limit-hit";
        return {
            unit, kind: "failed", restarts: s.restarts ?? 0,
            text: loop ? "error: crash loop — systemd stopped restarting it (bmfk ps log, then bmfk ps start)"
                : `error: failed${s.result ? ` (${s.result})` : ""} — bmfk ps log, then bmfk ps start`,
        };
    }
}
