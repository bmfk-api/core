// Probe / scan detection — MONITORING ONLY, never blocks a request.
//
// Every finished response is scored by what it looks like (scanner paths, injection payloads,
// enumeration of unknown URLs, auth failures, exotic HTTP methods). Points accumulate per client IP
// and decay over time; crossing a level writes one stable log line ("THREAT ip=…") that external
// tooling such as fail2ban can act on, if anyone decides to. Normal traffic scores 0 and is never
// stored, so memory is bounded by suspicious addresses only.
//
// Kept across restarts in <data folder>/<project>/threats.json (addresses, user agents, sanitized URLs —
// never bodies): saved every minute when something changed and on shutdown, by the live process only.

import fs from "fs";
import path from "path";
import { logWarn, LogService } from "../LogService";
import { onWriterChange } from "../helper/AppDataPath";

export type TThreatCategory = "scanner" | "injection" | "enumeration" | "auth" | "method" | "not-found";
export type TThreatLevel = "none" | "suspicious" | "high";

// Paths a Node JSON API never serves. One hit is enough to call it a probe.
const SCANNER_PATHS: RegExp[] = [
    /\/\.(?:env|git|svn|hg|aws|ssh|DS_Store|htaccess|htpasswd|npmrc|dockerenv)(?:[\/.]|$)/i,
    /\/wp-(?:login|admin|content|includes|config|json)/i,
    /\/(?:xmlrpc|phpinfo|phpmyadmin|adminer)\b/i,
    /\/(?:cgi-bin|actuator|server-status|server-info|jmx-console|manager\/html)(?:\/|$)/i,
    /\.(?:php\d?|aspx?|jsp|cgi|pl|cfm)(?:$|\?|\/)/i,
    /(?:etc\/passwd|win\.ini|boot\.ini|id_rsa)/i,
];

// Exploitation attempts. Checked in path + query always, in the body only for failed requests —
// legitimate traffic (2xx) is never body-scanned, which keeps both cost and false positives down.
const INJECTION: RegExp[] = [
    /\.\.(?:\/|\\|%2f|%5c)|%2e%2e(?:\/|%2f|%5c)/i,                                         // path traversal
    /\bunion\b[\s\S]{0,40}\bselect\b|\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+|'\s*(?:or|and)\s+'|;\s*(?:drop|truncate)\s+table/i, // SQL
    /<\s*script\b|javascript:|\bon(?:error|load)\s*=/i,                                    // XSS
    /\$\{\s*(?:jndi|env|sys|java):/i,                                                      // log4shell-style lookups
    /(?:;|\|\||&&|\|)\s*(?:cat|wget|curl|bash|nc|whoami)\b|\$\((?:cat|id|whoami|curl|wget)\b/i, // command injection
];

const ODD_METHODS = new Set(["TRACE", "TRACK", "PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK", "CONNECT", "DEBUG", "SEARCH"]);

const WEIGHT: Record<TThreatCategory, number> = {
    scanner: 10, injection: 8, enumeration: 10, method: 5, auth: 2, "not-found": 1,
};

interface ISample { ts: number; method: string; url: string; status: number; categories: TThreatCategory[]; }

interface IRecord {
    ip: string;
    score: number; scoreAt: number;
    firstSeen: number; lastSeen: number; hits: number;
    categories: Partial<Record<TThreatCategory, number>>;
    ua: string | null;
    samples: ISample[];
    notFound: Map<string, number>;   // distinct unknown paths within the enumeration window
    enumFlaggedAt: number;
}

export interface IThreatObservation {
    ip: string; method: string; url: string; status: number;
    ua?: string | null; body?: unknown; contentLength?: number;
}

export class ThreatMonitor {
    static HALF_LIFE_MS = 30 * 60 * 1000;         // score halves every 30 min without new hits
    static LEVEL_SUSPICIOUS = 10;
    static LEVEL_HIGH = 30;
    static ENUM_WINDOW_MS = 5 * 60 * 1000;
    static ENUM_DISTINCT_PATHS = 10;              // distinct unknown URLs in the window = enumeration
    static MAX_IPS = 5000;
    static MAX_EVENTS = 500;
    static MAX_BODY_SCAN = 8 * 1024;

    private static records = new Map<string, IRecord>();
    private static events: (ISample & { ip: string; score: number })[] = [];

    // ---- persistence ----
    static SAVE_EVERY_MS = 60_000;
    private static file: string | null = null;
    private static writer = false;
    private static dirty = false;
    private static timer: NodeJS.Timeout | null = null;

    /** Keep threats in this file across restarts (null → memory only). */
    static configure(file: string | null) {
        ThreatMonitor.file = file;
        if (!file) return;
        ThreatMonitor.load();
        onWriterChange(writer => {
            ThreatMonitor.writer = writer;
            if (writer) ThreatMonitor.load();   // a switch to this slot: take over what the other slot saw
        });
        if (!ThreatMonitor.timer) {
            ThreatMonitor.timer = setInterval(() => ThreatMonitor.save(), ThreatMonitor.SAVE_EVERY_MS);
            ThreatMonitor.timer.unref?.();
        }
    }

    /** Write the file now if this process is the writer and something changed. Never throws. */
    static save(): boolean {
        const file = ThreatMonitor.file;
        if (!file || !ThreatMonitor.writer || !ThreatMonitor.dirty) return false;
        try {
            const doc = {
                version: 1,
                savedAt: Date.now(),
                records: Array.from(ThreatMonitor.records.values()).map(r => ({ ...r, notFound: Array.from(r.notFound.entries()) })),
                events: ThreatMonitor.events,
            };
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            const tmp = file + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
            fs.renameSync(tmp, file);
            ThreatMonitor.dirty = false;
            return true;
        } catch (e: any) {
            logWarn("threats: cannot save " + file + ": " + (e?.message ?? e));
            return false;
        }
    }

    // Merges the file into memory: per address the more recent record wins; events are joined.
    private static load() {
        const file = ThreatMonitor.file;
        if (!file || !fs.existsSync(file)) return;
        let doc: any;
        try { doc = JSON.parse(fs.readFileSync(file, "utf-8")); }
        catch (e: any) { logWarn("threats: cannot read " + file + ": " + (e?.message ?? e)); return; }

        const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        for (const raw of Array.isArray(doc?.records) ? doc.records : []) {
            if (!raw || typeof raw.ip !== "string") continue;
            const mine = ThreatMonitor.records.get(raw.ip);
            if (mine && mine.lastSeen >= num(raw.lastSeen)) continue;
            ThreatMonitor.records.set(raw.ip, {
                ip: raw.ip, score: num(raw.score), scoreAt: num(raw.scoreAt),
                firstSeen: num(raw.firstSeen), lastSeen: num(raw.lastSeen), hits: num(raw.hits),
                categories: raw.categories && typeof raw.categories === "object" ? raw.categories : {},
                ua: typeof raw.ua === "string" ? raw.ua : null,
                samples: Array.isArray(raw.samples) ? raw.samples.slice(-10) : [],
                notFound: new Map(Array.isArray(raw.notFound) ? raw.notFound : []),
                enumFlaggedAt: num(raw.enumFlaggedAt),
            });
        }
        // Map order is LRU (oldest first): re-sort after the merge, then trim.
        const sorted = Array.from(ThreatMonitor.records.values()).sort((a, b) => a.lastSeen - b.lastSeen);
        ThreatMonitor.records = new Map(sorted.slice(-ThreatMonitor.MAX_IPS).map(r => [r.ip, r]));

        const seen = new Set(ThreatMonitor.events.map(e => `${e.ts}|${e.ip}|${e.url}`));
        const incoming = (Array.isArray(doc?.events) ? doc.events : [])
            .filter((e: any) => e && typeof e.ip === "string" && typeof e.ts === "number" && !seen.has(`${e.ts}|${e.ip}|${e.url}`));
        ThreatMonitor.events = ThreatMonitor.events.concat(incoming).sort((a, b) => a.ts - b.ts).slice(-ThreatMonitor.MAX_EVENTS);
    }

    private static decayed(r: IRecord, now: number): number {
        return r.score * Math.pow(0.5, (now - r.scoreAt) / ThreatMonitor.HALF_LIFE_MS);
    }

    static levelOf(score: number): TThreatLevel {
        return score >= ThreatMonitor.LEVEL_HIGH ? "high" : score >= ThreatMonitor.LEVEL_SUSPICIOUS ? "suspicious" : "none";
    }

    private static rank(l: TThreatLevel) { return l === "high" ? 2 : l === "suspicious" ? 1 : 0; }

    /** Categories this single request matches (not counting enumeration, which needs history). */
    static classify(o: IThreatObservation): TThreatCategory[] {
        const cats = new Set<TThreatCategory>();
        let target = String(o.url ?? "");
        try { target = decodeURIComponent(target); } catch { /* keep raw on bad encoding */ }

        if (SCANNER_PATHS.some(r => r.test(target))) cats.add("scanner");
        if (INJECTION.some(r => r.test(target))) cats.add("injection");

        if (o.status >= 400 && !cats.has("injection") && o.body !== undefined && o.body !== null
            && !(o.contentLength && o.contentLength > 64 * 1024)) {
            let text = "";
            try { text = typeof o.body === "string" ? o.body : JSON.stringify(o.body); } catch { text = ""; }
            if (text && INJECTION.some(r => r.test(text.slice(0, ThreatMonitor.MAX_BODY_SCAN)))) cats.add("injection");
        }

        if (ODD_METHODS.has(String(o.method).toUpperCase())) cats.add("method");
        if (o.status === 401 || o.status === 403) cats.add("auth");
        if (o.status === 404) cats.add("not-found");
        return Array.from(cats);
    }

    static observe(o: IThreatObservation) {
        if (!o || !o.ip) return;
        const cats = ThreatMonitor.classify(o);
        if (cats.length === 0) return;   // normal traffic: nothing to remember

        const now = Date.now();
        let r = ThreatMonitor.records.get(o.ip);
        if (r) ThreatMonitor.records.delete(o.ip);   // re-insert below → Map order is LRU
        else r = { ip: o.ip, score: 0, scoreAt: now, firstSeen: now, lastSeen: now, hits: 0,
                   categories: {}, ua: null, samples: [], notFound: new Map(), enumFlaggedAt: 0 };

        // Enumeration: many DIFFERENT unknown URLs in a short window, rewarded once per window.
        const path = String(o.url ?? "").split("?")[0];
        if (cats.includes("not-found")) {
            r.notFound.set(path, now);
            for (const [p, ts] of r.notFound) if (now - ts > ThreatMonitor.ENUM_WINDOW_MS) r.notFound.delete(p);
            while (r.notFound.size > 50) r.notFound.delete(r.notFound.keys().next().value as string);
            if (r.notFound.size >= ThreatMonitor.ENUM_DISTINCT_PATHS && now - r.enumFlaggedAt > ThreatMonitor.ENUM_WINDOW_MS) {
                cats.push("enumeration");
                r.enumFlaggedAt = now;
            }
        }

        const before = ThreatMonitor.decayed(r, now);
        const add = cats.reduce((sum, c) => sum + WEIGHT[c], 0);
        r.score = before + add;
        r.scoreAt = now;
        r.lastSeen = now;
        r.hits++;
        if (o.ua) r.ua = String(o.ua).slice(0, 200);
        for (const c of cats) r.categories[c] = (r.categories[c] ?? 0) + 1;

        // Only the URL is kept (sanitized, truncated) — never the body.
        const sample: ISample = { ts: now, method: String(o.method), url: LogService.sanitize(String(o.url ?? "")).slice(0, 200),
                                  status: o.status, categories: cats };
        r.samples.push(sample);
        if (r.samples.length > 10) r.samples.shift();

        ThreatMonitor.records.set(o.ip, r);
        ThreatMonitor.dirty = true;
        while (ThreatMonitor.records.size > ThreatMonitor.MAX_IPS)
            ThreatMonitor.records.delete(ThreatMonitor.records.keys().next().value as string);

        // Low-weight noise (a single 404) does not deserve the event feed.
        if (add >= WEIGHT.auth) {
            ThreatMonitor.events.push({ ...sample, ip: o.ip, score: Math.round(r.score) });
            if (ThreatMonitor.events.length > ThreatMonitor.MAX_EVENTS) ThreatMonitor.events.shift();
        }

        // One log line per level increase — stable format for log-based tooling.
        const prev = ThreatMonitor.levelOf(before), next = ThreatMonitor.levelOf(r.score);
        if (ThreatMonitor.rank(next) > ThreatMonitor.rank(prev)) {
            const allCats = Object.keys(r.categories).join(",");
            logWarn(`THREAT ip=${o.ip} level=${next} score=${Math.round(r.score)} categories=${allCats} last=${o.method} ${sample.url}`);
        }
    }

    static snapshot(limit = 50) {
        const now = Date.now();
        const offenders = Array.from(ThreatMonitor.records.values())
            .map(r => {
                const score = ThreatMonitor.decayed(r, now);
                return { ip: r.ip, score: Math.round(score * 10) / 10, level: ThreatMonitor.levelOf(score),
                         firstSeen: r.firstSeen, lastSeen: r.lastSeen, hits: r.hits,
                         categories: r.categories, userAgent: r.ua, samples: r.samples.slice().reverse() };
            })
            .filter(o => o.score >= 1)
            .sort((a, b) => b.score - a.score);
        return {
            generatedAt: now,
            settings: { halfLifeMinutes: ThreatMonitor.HALF_LIFE_MS / 60000, suspiciousAt: ThreatMonitor.LEVEL_SUSPICIOUS, highAt: ThreatMonitor.LEVEL_HIGH },
            totals: {
                tracked: offenders.length,
                suspicious: offenders.filter(o => o.level === "suspicious").length,
                high: offenders.filter(o => o.level === "high").length,
            },
            offenders: offenders.slice(0, Math.max(1, Math.min(limit, 500))),
            recent: ThreatMonitor.events.slice(-Math.max(1, Math.min(limit, 500))).reverse(),
        };
    }

    /** Test helper / manual reset. */
    static reset() { ThreatMonitor.records.clear(); ThreatMonitor.events = []; ThreatMonitor.dirty = true; }
}
