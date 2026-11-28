import fs from "fs";
import net from "net";
import path from "path";
import crypto from "crypto";
import { IpAllowList } from "../helper/IpAllowList";
import { AppData, appDataPath } from "../helper/AppDataPath";
import { logError, logInfo, logWarn } from "../LogService";

export const BLOCKED_IPS_FILE = "blocked-ips.json";

export interface IBlockedIp {
    ip: string;              // an address or a CIDR subnet
    reason?: string;         // for the operator only — never sent to the client
    until?: string | null;   // ISO date/time; absent or null → permanent
    by?: string;             // who added it (monitor login, or absent when edited by hand)
    at?: string;             // when it was added
}

// Addresses refused by the whole service. Kept in one JSON file (an array of IBlockedIp) that is
// edited by hand or from the monitor and re-read on change — no restart.
//
// Default location: always ABOVE the folder with the code, so deploys and restores (which replace
// that folder) never touch it:
//   blue-green  /var/node/app/blue/…  →  /var/node/app/blocked-ips.json   (shared by both slots)
//   otherwise   /var/node/app/…       →  /var/node/blocked-ips.app.json   (named after the project folder)
export class BlockedIps {
    private static file: string | null = null;
    private static entries: IBlockedIp[] = [];
    private static list: net.BlockList | null = null;
    private static nextExpiry = Infinity;
    private static hash = "";
    private static refusedHash = "";
    private static debounce: NodeJS.Timeout | null = null;
    private static watching = false;
    private static hits = new Map<string, { count: number, lastLogged: number }>();

    static configure(file?: string | null) {
        BlockedIps.file = path.resolve(file || BlockedIps.defaultPath());
        BlockedIps.load(true);
        BlockedIps.watch();
    }

    static get path(): string | null { return BlockedIps.file; }

    // <data folder>/<project>/blocked-ips.json. A file already at the old place (beside the deployed
    // code) keeps being used — moving it is the operator's call, so a block list is never lost.
    static defaultPath(): string {
        const dir = AppData.dir("");
        return dir ? path.join(dir, BLOCKED_IPS_FILE) : appDataPath("blocked-ips", ".json");
    }

    static validate(value: any): string | null {
        if (!Array.isArray(value)) return "the file must hold an array of { ip, reason?, until? }";
        for (const [i, e] of value.entries()) {
            if (!e || typeof e !== "object" || typeof e.ip !== "string") return `entry ${i}: "ip" is required`;
            const built = IpAllowList.build([e.ip]);
            if (built.error) return `entry ${i}: ${built.error}`;
            if (e.until !== undefined && e.until !== null && Number.isNaN(Date.parse(e.until))) return `entry ${i}: "until" is not a date`;
            if (e.reason !== undefined && typeof e.reason !== "string") return `entry ${i}: "reason" must be text`;
        }
        return null;
    }

    private static load(initial = false) {
        const file = BlockedIps.file;
        if (!file) return;
        let raw: string;
        try {
            raw = fs.readFileSync(file, "utf-8");
        } catch (e: any) {
            if (e?.code === "ENOENT") { if (BlockedIps.hash !== "missing") { BlockedIps.hash = "missing"; BlockedIps.apply([]); } return; }
            logWarn(`Blocked IPs: cannot read ${file} (${e?.message ?? e}) — keeping the current list`);
            return;
        }
        const hash = crypto.createHash("sha256").update(raw).digest("hex");
        if (hash === BlockedIps.hash || hash === BlockedIps.refusedHash) return;
        let parsed: any;
        try { parsed = raw.trim() ? JSON.parse(raw) : []; }
        catch (e: any) { BlockedIps.refusedHash = hash; logError(`Blocked IPs: ${file} is not valid JSON (${e?.message ?? e}) — change ignored, keeping the current list`); return; }
        const problem = BlockedIps.validate(parsed);
        if (problem) { BlockedIps.refusedHash = hash; logError(`Blocked IPs: ${file} — ${problem}; change ignored, keeping the current list`); return; }
        BlockedIps.hash = hash;
        BlockedIps.refusedHash = "";
        BlockedIps.apply(parsed);
        const active = BlockedIps.entries.filter(e => BlockedIps.active(e)).length;
        logInfo(`Blocked IPs ${initial ? "loaded" : "reloaded"} from ${file}: ${active} active of ${parsed.length}`);
    }

    private static active(e: IBlockedIp, now = Date.now()): boolean {
        return !e.until || Date.parse(e.until) > now;
    }

    // Rebuilt on load and whenever an entry runs out; checks stay a single BlockList lookup.
    private static apply(entries: IBlockedIp[]) {
        BlockedIps.entries = entries;
        const now = Date.now();
        const live = entries.filter(e => BlockedIps.active(e, now));
        BlockedIps.list = IpAllowList.build(live.map(e => e.ip)).list;
        BlockedIps.nextExpiry = Math.min(Infinity, ...live.filter(e => e.until).map(e => Date.parse(e.until!)));
    }

    // Loopback is never blocked: behind a proxy without X-Real-IP every request looks local, and
    // one ban would take the whole service down.
    static isBlocked(ip: string | undefined | null): boolean {
        if (!BlockedIps.list || !ip || ip === "127.0.0.1" || ip === "::1") return false;
        if (Date.now() >= BlockedIps.nextExpiry) BlockedIps.apply(BlockedIps.entries);
        return !!BlockedIps.list && IpAllowList.allows(BlockedIps.list, ip);
    }

    // Counted for the monitor; logged once per address per 10 minutes so a hammering client can't flood the log.
    static noteHit(ip: string) {
        const h = BlockedIps.hits.get(ip) ?? { count: 0, lastLogged: 0 };
        h.count++;
        if (Date.now() - h.lastLogged > 10 * 60 * 1000) {
            h.lastLogged = Date.now();
            logWarn(`Blocked IPs: refused ${ip} (${h.count} request(s) so far)`);
        }
        BlockedIps.hits.set(ip, h);
        if (BlockedIps.hits.size > 10000) BlockedIps.hits.delete(BlockedIps.hits.keys().next().value!);
    }

    static snapshot() {
        const now = Date.now();
        return {
            file: BlockedIps.file,
            entries: BlockedIps.entries.map(e => ({ ...e, active: BlockedIps.active(e, now) })),
            hits: Object.fromEntries(Array.from(BlockedIps.hits.entries()).map(([ip, h]) => [ip, h.count])),
        };
    }

    // Read-modify-write of the file as it is on disk now, so a hand edit isn't overwritten.
    private static update(change: (list: IBlockedIp[]) => IBlockedIp[]) {
        const file = BlockedIps.file;
        if (!file) throw new Error("blocked IPs are not configured");
        let current: IBlockedIp[] = [];
        const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
        if (raw.trim()) {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON — fix it by hand first`); }
            const problem = BlockedIps.validate(parsed);
            if (problem) throw new Error(`${file} is invalid (${problem}) — fix it by hand first`);
            current = parsed;
        }
        const next = change(current);
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tmp, file);
        BlockedIps.load();
    }

    static add(entry: IBlockedIp) {
        BlockedIps.update(list => [...list.filter(e => e.ip !== entry.ip), entry]);
    }

    static remove(ip: string): boolean {
        let removed = false;
        BlockedIps.update(list => list.filter(e => { if (e.ip === ip) { removed = true; return false; } return true; }));
        return removed;
    }

    private static watch() {
        if (BlockedIps.watching || !BlockedIps.file) return;
        BlockedIps.watching = true;
        const dir = path.dirname(BlockedIps.file), name = path.basename(BlockedIps.file);
        try {
            fs.watch(dir, (_e, filename) => {
                if (filename && filename !== name) return;
                if (BlockedIps.debounce) clearTimeout(BlockedIps.debounce);
                BlockedIps.debounce = setTimeout(() => { BlockedIps.debounce = null; BlockedIps.load(); }, 200);
            }).unref();
        } catch (e: any) {
            logWarn(`Blocked IPs: cannot watch ${dir} (${e?.message ?? e}) — changes are picked up within a minute`);
        }
        setInterval(() => BlockedIps.load(), 60_000).unref();
    }
}
