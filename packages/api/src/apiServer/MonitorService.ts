import { Signal, Req } from "../signal/Signal";
import { BaseService } from "./BaseService";
import { IResponse } from "./structures/Interfaces";
import { YYYYMMDDHH } from "./helper/YYYYMMDDHH";
import { logWarn, logInfo } from "./LogService";
import os from "os";
import fs from "fs/promises";
import path from "path";
import { AppData, appDataPath, APP_DATA_ROOT_ENV, onWriterChange } from "./helper/AppDataPath";

export interface ICustomEvent {
	event: string;
	data?: any;
}

export interface IStat{
	timestamp: number;
	slot:IMonitorSlot
}

export const S_STAT_REGISTRATE_REQUEST = new Signal<IResponse>();
export const S_STAT_REGISTRATE_CUSTOM_EVENT = new Signal<ICustomEvent>();
export const S_STAT_REGISTRATE_SERVICE = new Signal<string>();
export const S_STAT_REGISTRATE_HTTP_REQUEST = new Signal<{url:string}>();
// Fired on OUTGOING request completion (unlike ..._HTTP_REQUEST which fires on start and only
// knows the url). Carries success/fail + latency, so we can bucket per-host ok/fail counts and
// per-host p95 into the minute slots (charts: outbound success/fail over time, and p95 over time).
export const S_STAT_REGISTRATE_HTTP_RESULT = new Signal<{host:string, ok:boolean, ms:number}>();
export const S_STAT_REGISTRATE_SQL_REQUEST = new Signal<{success:boolean, query:string}>();

export const REQ_STAT = new Req<{range:"week"|"day"|"hour"}, IStat[]>(
	undefined,
	"REQ_STAT"
);

// List persisted week keys available on disk (e.g. ["2026-W36","2026-W37"]), newest last.
export const REQ_STAT_WEEKS = new Req<void, string[]>(undefined, "REQ_STAT_WEEKS");
// Read one persisted week from disk (minute-resolution for the live week, hourly for archives).
export const REQ_STAT_WEEK = new Req<{weekKey:string}, IStat[]>(undefined, "REQ_STAT_WEEK");


type IMonitorSlot = {
	yyyymmddhhii: number;
	cpu: number;
	memory: {
		rss: number;
		heapUsed: number;
		heapTotal: number;
		external: number;
	};
	externalCalls?: number;
	successEp:Record<string, number>; // inbound endpoint success counts
	failEp:Record<string, number>; // inbound endpoint fail counts
	http: Record<string, number>; // outbound request counts by url-path (started)
	http_ok: Record<string, number>; // outbound SUCCESS counts by host (completed)
	http_fail: Record<string, number>; // outbound FAIL counts by host (completed)
	httpP95: Record<string, number>; // outbound p95 latency (ms) by host, computed at minute close
	success_sql:Record<string, number>; // sql query counts
	fail_sql:Record<string, number>; // sql query counts
}

export class MonitorService extends BaseService {
	
	slots:Map<number,Map<number,IMonitorSlot>> = new Map(); // max 7 days in memory,
	intervalMs = 59_000; // 1 min (1440 slots = 1 day)
	lastCpuUsage: NodeJS.CpuUsage | null = null;
	lastTimestamp: number | null = null;

	// ---- disk persistence (on by default; metricsDir: false turns it off) ----
	// Live week is written as JSONL: one line per finalized minute slot (cheap append, no
	// rewrite of a growing file). Archived weeks are downsampled to hourly .json on rotation.
	// Retention: newest 10 weeks kept on disk; last 7 days hydrated into memory on boot.
	//
	// One writer per folder: only the live process writes. A blue-green standby (and the old slot
	// after a switch) keeps counting in memory but leaves the files alone; when it becomes live it
	// reloads the history the other slot wrote, so the charts carry on across deploys and restarts.
	// pm2 cluster workers other than instance 0 never write.
	private metricsDir: string | null;
	private _live = false;
	private static MAX_WEEKS = 10;
	// Persisted-slot schema version. Bump whenever the on-disk slot shape changes. It's written
	// into archive headers and lets us reason about format drift; actual robustness comes from
	// normalizeSlot(), which coerces ANY parsed object to the current shape so a deploy that
	// changes the format (or a rollback / mixed blue-green) never crashes on old/newer files.
	private static SCHEMA_VERSION = 2;
	private _persistReady = false;      // gate persistTick until hydrate/init finished
	private _flushedUpTo = 0;           // highest minute-key already appended to disk
	private _lastSeenWeekKey: string | null = null;

	constructor(metricsDir?: string | null | false) {
		super("MonitorService");
		this.metricsDir = metricsDir === false || metricsDir === null ? null
			: metricsDir && metricsDir.length > 0 ? metricsDir
			: MonitorService.defaultDir();
		setInterval(() => this.collectUsage(), this.intervalMs);
	}
	// <data folder>/<project>/metrics; beside the code when it can't be created (said at startup).
	private static defaultDir(): string {
		const dir = AppData.dir("metrics");
		if (dir) return dir;
		const fallback = appDataPath("metrics");
		logWarn(`Metrics persistence: can't create ${AppData.root()}/${AppData.project()}/metrics (create ${AppData.root()} and give the app user write access, or set ${APP_DATA_ROOT_ENV}) — using ${fallback}`);
		return fallback;
	}

	async init() {
		super.init();
		REQ_STAT.listener=async (req)=>this.getEPStat(req);
		REQ_STAT_WEEKS.listener=async ()=>this.listPersistedWeeks();
		REQ_STAT_WEEK.listener=async (req)=>this.readPersistedWeek(req.weekKey);
		S_STAT_REGISTRATE_HTTP_REQUEST.subscribe((data) => this.onHttpRequestRegistrate(data));
		S_STAT_REGISTRATE_HTTP_RESULT.subscribe((data) => this.onHttpResultRegistrate(data));
		S_STAT_REGISTRATE_SQL_REQUEST.subscribe((data) => this.onSQLRequestRegistrate(data));
		S_STAT_REGISTRATE_REQUEST.subscribe((data) => this.onStatRegistrate(data));

		// Say plainly at startup whether history survives a restart — an unset metricsDir used to
		// fail silently (empty archive, no hint why).
		if (!this.metricsDir) {
			logInfo("Metrics persistence: OFF (metricsDir: false) — history is in memory only and lost on restart.", "MonitorService");
		} else {
			this.metricsDir = path.resolve(this.metricsDir);
			const appDir = path.resolve(process.cwd());
			if (this.metricsDir === appDir || this.metricsDir.startsWith(appDir + path.sep))
				logWarn(`Metrics persistence: metricsDir "${this.metricsDir}" is inside the application directory — a deploy that cleans it will erase the history. Use an absolute path outside the project.`);
			else
				logInfo(`Metrics persistence: ON → ${this.metricsDir}`, "MonitorService");
		}

		if (this.metricsDir) {
			try {
				await fs.mkdir(this.metricsDir, { recursive: true });
			} catch (e:any) {
				logWarn("metrics: cannot create metricsDir, disk persistence disabled: " + (e?.message ?? e));
				this.metricsDir = null;
			}
		}
		if (this.metricsDir) {
			await this.hydrate();              // last 7 days back into memory (seamless restart)
			this._lastSeenWeekKey = this.weekKey(new Date());
			this._persistReady = true;
			this.followLive();
		}
	}

	// Writes start once this process is known to be the live one (not blue-green: right away, after
	// the first state check). On becoming live — a switch to this slot — reload what the previous
	// live slot wrote while this one stood by.
	private followLive() {
		const canWrite = onWriterChange(live => {
			if (live === this._live) return;
			this._live = live;
			if (live)
				this.hydrate().then(() => this.rotate()).catch(() => {});
		});
		if (!canWrite)
			logInfo(`Metrics persistence: pm2 worker ${process.env.NODE_APP_INSTANCE} — only instance 0 writes ${this.metricsDir}`, "MonitorService");
	}

	// Flush the last in-progress minute on graceful shutdown so a planned restart/deploy
	// doesn't lose it. (finishService is registered into BaseService's SIGINT/SIGTERM finalizers.)
	async finishService() {
		await super.finishService();
		if (this.metricsDir && this._persistReady && this._live)
			await this.persistTick(true).catch(() => {});
	}

	async getEPStat(req: { range: "week" | "day" | "hour" }): Promise<IStat[]> {
        const allSlots: IMonitorSlot[] = [];
    
		// Собираем данные в хронологическом порядке
		const sortedDayKeys = Array.from(this.slots.keys()).sort((a, b) => a - b);
		for (const dayKey of sortedDayKeys) {
			const dayMap = this.slots.get(dayKey)!;
			const sortedMinKeys = Array.from(dayMap.keys()).sort((a, b) => a - b);
			for (const minKey of sortedMinKeys) {
				allSlots.push(dayMap.get(minKey)!);
			}
		}

		// Определяем шаг агрегации (в минутах)
		// hour -> 1 (каждая минута), day -> 10 (каждые 10 мин), week -> 30 (полчаса)
		const steps = { hour: 1, day: 10, week: 30 };
		const step = steps[req.range] || 1;

		// Ограничиваем выборку под конкретный запрос
		const limits = { hour: 60, day: 1440, week: 7200 };
		const limitedSlots = allSlots.slice(-(limits[req.range] || 60));

		return this.aggregate(limitedSlots, step);
    }

    private aggregate(allSlots: IMonitorSlot[], step: number): IStat[] {
        const result: IStat[] = [];
        
        for (let i = 0; i < allSlots.length; i += step) {
            const chunk = allSlots.slice(i, i + step);
            const first = chunk[0];
            
            const agg: IMonitorSlot = {
                yyyymmddhhii: first.yyyymmddhhii,
                cpu: 0,
                memory: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 },
                successEp: {},
				failEp: {},
				http:{},
				http_ok:{},
				http_fail:{},
				httpP95:{},
				success_sql:{},
				fail_sql:{}
            };

            const sum = (dst: Record<string, number>, src?: Record<string, number>) => {
                if (!src) return;
                for (const [k, v] of Object.entries(src)) dst[k] = (dst[k] || 0) + v;
            };
            const maxInto = (dst: Record<string, number>, src?: Record<string, number>) => {
                if (!src) return;
                for (const [k, v] of Object.entries(src)) dst[k] = Math.max(dst[k] || 0, v);
            };

            chunk.forEach(s => {
                agg.cpu += s.cpu;
                agg.memory.rss += s.memory.rss;
                agg.memory.heapUsed += s.memory.heapUsed;
                agg.memory.heapTotal += s.memory.heapTotal;
                agg.memory.external += s.memory.external;
                sum(agg.successEp, s.successEp);
                sum(agg.failEp, s.failEp);
                sum(agg.http, s.http);
                sum(agg.http_ok, s.http_ok);
                sum(agg.http_fail, s.http_fail);
                sum(agg.success_sql, s.success_sql);
                sum(agg.fail_sql, s.fail_sql);
                // p95 is a percentile — take the WORST over the merged sub-buckets, never sum/avg.
                maxInto(agg.httpP95, s.httpP95);
            });

            const len = chunk.length;
            // Усредняем показатели
            agg.cpu = Number((agg.cpu / len).toFixed(2));
            agg.memory.rss = Math.round(agg.memory.rss / len);
            agg.memory.heapUsed = Math.round(agg.memory.heapUsed / len);
            agg.memory.heapTotal = Math.round(agg.memory.heapTotal / len);
            agg.memory.external = Math.round(agg.memory.external / len);

            result.push({ 
                timestamp: this.slotToTimestamp(agg.yyyymmddhhii), 
                slot: agg 
            });
        }
        return result;
    }

    private slotToTimestamp(val: number): number {
        const s = val.toString();
        // Парсим YYYY-MM-DD HH:mm
        return new Date(
            +s.substring(0, 4),
            +s.substring(4, 6) - 1,
            +s.substring(6, 8),
            +s.substring(8, 10),
            +s.substring(10, 12)
        ).getTime();
    }

	// Registrate each API call and store it in memory in minute slots
	onStatRegistrate(data: IResponse) {
		const date = new Date();
		const yyyymmdd = parseInt(YYYYMMDDHH(date, "yyyymmdd"));
		const yyyymmddhhmm = parseInt(YYYYMMDDHH(date, "yyyymmddhhmm"));

		const ep = data.endpoint || "unknown";
		// get or create slot for current day
		const slot = this.getSlot(yyyymmddhhmm);

		if(!data.error)
			slot.successEp[ep] = (slot.successEp[ep] || 0) + 1;
		else
			slot.failEp[ep] = (slot.failEp[ep] || 0) + 1;
	}


	// Collect system usage stats
	async collectUsage() {
		const usage = process.cpuUsage();
		const now = Date.now();
		const yyyymmddhhmm = parseInt(YYYYMMDDHH(new Date(now), "yyyymmddhhmm"));
		// Close out p95 for all finished minutes before writing/persisting them.
		this.finalizeLatency(yyyymmddhhmm);
		const slot = this.getSlot(yyyymmddhhmm);

		if (this.lastCpuUsage && this.lastTimestamp) {
			const diff = usage.user - this.lastCpuUsage.user;
			const sysdiff = usage.system - this.lastCpuUsage.system;
			const timeDiffMs = now - this.lastTimestamp;

			// Результат в процентах (0-100) на одно ядро
			// (микросекунды / 1000 = миллисекунды) / время_в_мс / кол-во_ядер * 100
			slot.cpu = Number(((diff + sysdiff) / 1000 / timeDiffMs / os.cpus().length * 100).toFixed(2));
		}
		
		this.lastCpuUsage = usage;
		this.lastTimestamp = now;

		const mem = process.memoryUsage();
		// Пишем сразу в мегабайтах, чтобы не гонять байты по сети
		slot.memory = {
			rss: Math.round(mem.rss / 1024 / 1024),
			heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
			heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
			external: Math.round(mem.external / 1024 / 1024),
		};

		// Persist finalized minutes to disk once per collection tick (~1/min).
		if (this.metricsDir && this._persistReady && this._live)
			await this.persistTick().catch(() => {});
	}


	// Максимум уникальных ключей в любом из Record<string,number> внутри слота.
	// При переполнении новые ключи сваливаются в "__other__".
	private static MAX_SLOT_KEYS = 100;

	/** SQL → плейсхолдеры: строковые литералы, числа, IN(...) сворачиваются в '?'. Чтобы кардинальность ключей не зависела от подставленных значений. */
	static normalizeQuery(query: string): string {
		const normalized = query
			.replace(/'(?:\\.|''|[^'])*'/g, "?")      // single-quoted strings (mysql escapes ' as \' or '')
			.replace(/"(?:\\.|""|[^"])*"/g, "?")      // double-quoted strings
			.replace(/\b\d+(?:\.\d+)?\b/g, "?")       // numeric literals
			.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)") // IN (?,?,?) → IN (?)
			.replace(/\s+/g, " ")
			.trim();
		return normalized.length > 300 ? normalized.substring(0, 300) : normalized;
	}

	/** URL → только path: query-string и fragment отрезаются. */
	static normalizeUrl(url: string): string {
		const q = url.indexOf("?");
		const h = url.indexOf("#");
		let end = url.length;
		if (q >= 0) end = Math.min(end, q);
		if (h >= 0) end = Math.min(end, h);
		const path = url.substring(0, end);
		return path.length > 200 ? path.substring(0, 200) : path;
	}

	/** Инкрементить счётчик ключа в Record с лимитом кардинальности. Новые ключи поверх лимита идут в "__other__". */
	private bumpCappedKey(record: Record<string, number>, key: string) {
		if (key in record) {
			record[key]++;
			return;
		}
		if (Object.keys(record).length >= MonitorService.MAX_SLOT_KEYS) {
			record["__other__"] = (record["__other__"] || 0) + 1;
			return;
		}
		record[key] = 1;
	}

	private onHttpRequestRegistrate(data: {url:string}) {
		const date = new Date();
		const yyyymmddhhmm = parseInt(YYYYMMDDHH(date, "yyyymmddhhmm"));
		const slot = this.getSlot(yyyymmddhhmm);
		this.bumpCappedKey(slot.http, MonitorService.normalizeUrl(data.url));
	}

	// Per-minute, per-host latency samples — transient, NOT persisted. Turned into slot.httpP95
	// at minute close (finalizeLatency). Capped so a hammered host can't grow it without bound.
	private _latByMinute: Map<number, Map<string, number[]>> = new Map();
	private static LAT_CAP_PER_MIN = 3000;

	private onHttpResultRegistrate(data: {host:string, ok:boolean, ms:number}) {
		const minuteKey = parseInt(YYYYMMDDHH(new Date(), "yyyymmddhhmm"));
		const slot = this.getSlot(minuteKey);
		this.bumpCappedKey(data.ok ? slot.http_ok : slot.http_fail, data.host);

		let hosts = this._latByMinute.get(minuteKey);
		if (!hosts) { hosts = new Map(); this._latByMinute.set(minuteKey, hosts); }
		let arr = hosts.get(data.host);
		if (!arr) { arr = []; hosts.set(data.host, arr); }
		if (arr.length < MonitorService.LAT_CAP_PER_MIN) arr.push(data.ms);
	}

	// Compute p95 for every buffered minute earlier than the current one (or including it on
	// shutdown), write it into slot.httpP95 per host, and drop the buffer. Runs every collectUsage
	// tick, so only the in-progress minute is ever buffered.
	private finalizeLatency(currentMinute: number, includeCurrent = false) {
		for (const [minuteKey, hosts] of this._latByMinute) {
			if (includeCurrent ? minuteKey > currentMinute : minuteKey >= currentMinute) continue;
			const slot = this.slots.get(Math.floor(minuteKey / 100))?.get(minuteKey);
			if (slot) {
				for (const [host, samples] of hosts) {
					if (!samples.length) continue;
					samples.sort((a, b) => a - b);
					const idx = Math.min(samples.length - 1, Math.max(0, Math.ceil(0.95 * samples.length) - 1));
					slot.httpP95[host] = samples[idx];
				}
			}
			this._latByMinute.delete(minuteKey);
		}
	}

	private onSQLRequestRegistrate(data: {success:boolean, query:string}) {
		const date = new Date();
		const yyyymmddhhmm = parseInt(YYYYMMDDHH(date, "yyyymmddhhmm"));
		const slot = this.getSlot(yyyymmddhhmm);
		const key = MonitorService.normalizeQuery(data.query);
		this.bumpCappedKey(data.success ? slot.success_sql : slot.fail_sql, key);
	}

	private getSlot(yyyymmddhhii: number): IMonitorSlot {
		const yyymmdd  = Math.floor(yyyymmddhhii / 100);
		let daySlots = this.slots.get(yyymmdd);
		if (!daySlots) {
			daySlots = new Map();
			this.slots.set(yyymmdd, daySlots);
			// keep max 7 days
			if(this.slots.size > 7){
				let key = this.slots.keys().next().value
				if(key)
					this.slots.delete(key);
			}
		}

		let slot = daySlots.get(yyyymmddhhii);
		if (!slot) {
			slot = {
				yyyymmddhhii,
				cpu: 0,
				memory: {
					rss: 0,
					heapUsed: 0,
					heapTotal: 0,
					external: 0,
				},
				successEp: {},
				failEp: {},
				http:{},
				http_ok:{},
				http_fail:{},
				httpP95:{},
				success_sql:{},
				fail_sql:{}
			};
			daySlots.set(yyyymmddhhii, slot);
		}

		return slot
	}

	// ==================== DISK PERSISTENCE ====================

	private liveFile(weekKey: string): string {
		return path.join(this.metricsDir!, `metrics_${weekKey}.jsonl`);
	}
	private archiveFile(weekKey: string): string {
		return path.join(this.metricsDir!, `metrics_${weekKey}.json`);
	}

	// ISO-8601 week key, e.g. "2026-W37". Note the ISO week-year can differ from the calendar
	// year at Dec/Jan boundaries — that's intentional and keeps weeks contiguous.
	private weekKey(date: Date): string {
		const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
		const dayNum = (d.getUTCDay() + 6) % 7;        // Mon=0 … Sun=6
		d.setUTCDate(d.getUTCDate() - dayNum + 3);      // move to the Thursday of this week
		const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
		const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
		firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
		const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
		return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
	}

	private async atomicWrite(file: string, content: string) {
		const tmp = file + ".tmp";
		await fs.writeFile(tmp, content, "utf-8");
		await fs.rename(tmp, file);
	}

	// Coerce ANY parsed object from disk into a valid current-shape slot. This is the schema-drift
	// firewall: a slot written by a different (older or newer) build might miss fields, carry extra
	// ones, or have wrong types — we fill defaults, drop unknown extras, and reject only genuinely
	// unusable rows (no numeric timestamp). Result: reading foreign-format files never throws.
	private normalizeSlot(raw: any): IMonitorSlot | null {
		if (!raw || typeof raw !== "object") return null;
		const key = Number(raw.yyyymmddhhii);
		if (!Number.isFinite(key)) return null;   // without a timestamp the slot is useless — skip
		const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const rec = (v: any): Record<string, number> => {
			const out: Record<string, number> = {};
			if (v && typeof v === "object" && !Array.isArray(v))
				for (const [k, val] of Object.entries(v))
					if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
			return out;
		};
		const m = raw.memory && typeof raw.memory === "object" ? raw.memory : {};
		return {
			yyyymmddhhii: key,
			cpu: num(raw.cpu),
			memory: { rss: num(m.rss), heapUsed: num(m.heapUsed), heapTotal: num(m.heapTotal), external: num(m.external) },
			successEp: rec(raw.successEp), failEp: rec(raw.failEp),
			http: rec(raw.http), http_ok: rec(raw.http_ok), http_fail: rec(raw.http_fail), httpP95: rec(raw.httpP95),
			success_sql: rec(raw.success_sql), fail_sql: rec(raw.fail_sql),
		};
	}

	// Tolerant JSONL reader: skips blank/corrupt lines (e.g. a truncated last line after a crash)
	// and normalizes every parsed slot to the current schema (see normalizeSlot).
	private async readJsonl(file: string): Promise<IMonitorSlot[]> {
		const txt = await fs.readFile(file, "utf-8");
		const out: IMonitorSlot[] = [];
		for (const line of txt.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const s = this.normalizeSlot(JSON.parse(t));
				if (s) out.push(s);
			} catch { /* tolerate truncated/corrupt line */ }
		}
		return out;
	}

	// Append every finalized minute slot (key > _flushedUpTo, and — unless flushing on shutdown —
	// strictly before the current minute so we never persist a still-mutating slot) as JSONL,
	// grouped by the week each slot belongs to (handles the week-boundary tick).
	private async persistTick(includeCurrentMinute = false) {
		if (!this.metricsDir) return;
		const nowKey = parseInt(YYYYMMDDHH(new Date(), "yyyymmddhhmm"));

		// Make sure p95 is written into the slots we're about to persist. On shutdown we also
		// finalize the in-progress minute (includeCurrentMinute) so its p95 isn't lost.
		this.finalizeLatency(nowKey, includeCurrentMinute);

		const pending: IMonitorSlot[] = [];
		for (const dayMap of this.slots.values()) {
			for (const slot of dayMap.values()) {
				const k = slot.yyyymmddhhii;
				if (k <= this._flushedUpTo) continue;
				if (!includeCurrentMinute && k >= nowKey) continue; // skip the in-progress minute
				pending.push(slot);
			}
		}
		pending.sort((a, b) => a.yyyymmddhhii - b.yyyymmddhhii);

		if (pending.length) {
			try {
				const byWeek = new Map<string, string>();
				for (const s of pending) {
					const wk = this.weekKey(new Date(this.slotToTimestamp(s.yyyymmddhhii)));
					byWeek.set(wk, (byWeek.get(wk) ?? "") + JSON.stringify(s) + "\n");
				}
				for (const [wk, text] of byWeek)
					await fs.appendFile(this.liveFile(wk), text, "utf-8");
				this._flushedUpTo = pending[pending.length - 1].yyyymmddhhii;
			} catch (e: any) {
				logWarn("metrics: persist append failed: " + (e?.message ?? e));
			}
		}

		// Week rollover → downsample the finished week to hourly and prune to MAX_WEEKS.
		const curWeek = this.weekKey(new Date());
		if (this._lastSeenWeekKey && this._lastSeenWeekKey !== curWeek)
			await this.rotate().catch(() => {});
		this._lastSeenWeekKey = curWeek;
	}

	// Downsample every non-current live week (.jsonl) to an hourly archive (.json), then prune
	// so at most MAX_WEEKS week-buckets remain on disk (oldest deleted first).
	private async rotate() {
		if (!this.metricsDir) return;
		try {
			const curWeek = this.weekKey(new Date());
			const files = await fs.readdir(this.metricsDir);
			for (const f of files) {
				const m = f.match(/^metrics_(\d{4}-W\d{2})\.jsonl$/);
				if (m && m[1] !== curWeek)
					await this.downsampleWeek(m[1]);
			}

			// Prune to newest MAX_WEEKS weeks (weekKey strings sort chronologically).
			const after = await fs.readdir(this.metricsDir);
			const byWeek = new Map<string, string[]>();
			for (const f of after) {
				const m = f.match(/^metrics_(\d{4}-W\d{2})\.(jsonl|json)$/);
				if (!m) continue;
				const arr = byWeek.get(m[1]) ?? [];
				arr.push(f);
				byWeek.set(m[1], arr);
			}
			const weeks = Array.from(byWeek.keys()).sort();               // ascending (oldest first)
			const excess = weeks.slice(0, Math.max(0, weeks.length - MonitorService.MAX_WEEKS));
			for (const wk of excess)
				for (const f of byWeek.get(wk)!)
					await fs.unlink(path.join(this.metricsDir!, f)).catch(() => {});
		} catch (e: any) {
			logWarn("metrics: rotate failed: " + (e?.message ?? e));
		}
	}

	private async downsampleWeek(weekKey: string) {
		const live = this.liveFile(weekKey);
		let slots: IMonitorSlot[];
		try { slots = await this.readJsonl(live); }
		catch { return; }                                                // no live file → nothing to do
		if (!slots.length) { await fs.unlink(live).catch(() => {}); return; }

		const byHour = new Map<number, IMonitorSlot[]>();
		for (const s of slots) {
			const hourKey = Math.floor(s.yyyymmddhhii / 100) * 100;        // zero the minutes
			const arr = byHour.get(hourKey) ?? [];
			arr.push(s);
			byHour.set(hourKey, arr);
		}
		const hourly = Array.from(byHour.entries())
			.sort((a, b) => a[0] - b[0])
			.map(([hourKey, arr]) => this.mergeSlots(hourKey, arr));

		await this.atomicWrite(this.archiveFile(weekKey),
			JSON.stringify({ version: MonitorService.SCHEMA_VERSION, weekKey, resolution: "hour", slots: hourly }));
		await fs.unlink(live).catch(() => {});
	}

	// Merge many slots into one (sum the count maps, average cpu/memory). Shared by downsampling.
	private mergeSlots(key: number, arr: IMonitorSlot[]): IMonitorSlot {
		const out: IMonitorSlot = {
			yyyymmddhhii: key, cpu: 0,
			memory: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 },
			successEp: {}, failEp: {}, http: {}, http_ok: {}, http_fail: {}, httpP95: {},
			success_sql: {}, fail_sql: {},
		};
		const add = (dst: Record<string, number>, src?: Record<string, number>) => {
			if (!src) return;
			for (const [k, v] of Object.entries(src)) dst[k] = (dst[k] || 0) + v;
		};
		const maxInto = (dst: Record<string, number>, src?: Record<string, number>) => {
			if (!src) return;
			for (const [k, v] of Object.entries(src)) dst[k] = Math.max(dst[k] || 0, v);
		};
		for (const s of arr) {
			out.cpu += s.cpu;
			out.memory.rss += s.memory.rss;
			out.memory.heapUsed += s.memory.heapUsed;
			out.memory.heapTotal += s.memory.heapTotal;
			out.memory.external += s.memory.external;
			add(out.successEp, s.successEp); add(out.failEp, s.failEp); add(out.http, s.http);
			add(out.http_ok, s.http_ok); add(out.http_fail, s.http_fail);
			add(out.success_sql, s.success_sql); add(out.fail_sql, s.fail_sql);
			maxInto(out.httpP95, s.httpP95);   // p95 → worst-in-window, never summed
		}
		const n = arr.length || 1;
		out.cpu = Number((out.cpu / n).toFixed(2));
		out.memory.rss = Math.round(out.memory.rss / n);
		out.memory.heapUsed = Math.round(out.memory.heapUsed / n);
		out.memory.heapTotal = Math.round(out.memory.heapTotal / n);
		out.memory.external = Math.round(out.memory.external / n);
		return out;
	}

	// On boot: pull the last 7 days back into memory from the live week file(s) so the live
	// `metrics` view is seamless across a restart. Older history stays on disk (read on demand).
	private async hydrate() {
		if (!this.metricsDir) return;
		try {
			const cutoff = parseInt(YYYYMMDDHH(new Date(Date.now() - 7 * 24 * 3600 * 1000), "yyyymmddhhmm"));
			const weeks = new Set([
				this.weekKey(new Date()),
				this.weekKey(new Date(Date.now() - 7 * 24 * 3600 * 1000)),   // 7 days can span 2 ISO weeks
			]);
			let maxKey = 0;
			for (const wk of weeks) {
				let slots: IMonitorSlot[];
				try { slots = await this.readJsonl(this.liveFile(wk)); }
				catch { continue; }                                          // file may not exist
				for (const s of slots) {
					if (s.yyyymmddhhii < cutoff) continue;
					const dayKey = Math.floor(s.yyyymmddhhii / 100);
					let dayMap = this.slots.get(dayKey);
					if (!dayMap) { dayMap = new Map(); this.slots.set(dayKey, dayMap); }
					dayMap.set(s.yyyymmddhhii, s);
					if (s.yyyymmddhhii > maxKey) maxKey = s.yyyymmddhhii;
				}
			}
			this._flushedUpTo = maxKey;   // never re-append what we just loaded
			while (this.slots.size > 7) {  // keep the same 7-day in-memory cap
				const oldest = Array.from(this.slots.keys()).sort((a, b) => a - b)[0];
				this.slots.delete(oldest);
			}
		} catch (e: any) {
			logWarn("metrics: hydrate failed: " + (e?.message ?? e));
		}
	}

	// ---- on-demand archive reads (REQ_STAT_WEEKS / REQ_STAT_WEEK) ----

	private async listPersistedWeeks(): Promise<string[]> {
		if (!this.metricsDir) return [];
		try {
			const files = await fs.readdir(this.metricsDir);
			const weeks = new Set<string>();
			for (const f of files) {
				const m = f.match(/^metrics_(\d{4}-W\d{2})\.(jsonl|json)$/);
				if (m) weeks.add(m[1]);
			}
			return Array.from(weeks).sort();
		} catch { return []; }
	}

	private async readPersistedWeek(weekKey: string): Promise<IStat[]> {
		if (!this.metricsDir || !/^\d{4}-W\d{2}$/.test(weekKey)) return [];
		let slots: IMonitorSlot[] = [];
		try {
			// Prefer the live (minute-resolution) file; fall back to the hourly archive.
			try { slots = await this.readJsonl(this.liveFile(weekKey)); }
			catch {
				const txt = await fs.readFile(this.archiveFile(weekKey), "utf-8");
				const rawSlots = JSON.parse(txt)?.slots;
				slots = Array.isArray(rawSlots)
					? rawSlots.map((r: any) => this.normalizeSlot(r)).filter((s): s is IMonitorSlot => s !== null)
					: [];
			}
		} catch { return []; }
		return slots
			.sort((a, b) => a.yyyymmddhhii - b.yyyymmddhhii)
			.map(s => ({ timestamp: this.slotToTimestamp(s.yyyymmddhhii), slot: s }));
	}

}
