// Shared data structures mirrored from the backend monitor service.
// See from_backend/Monitor.ts and from_backend/MonitorService.ts.

export type TRange = "hour" | "day" | "week";

export interface ILogItem {
	level: string;
	id: number;
	text: string;
	time: number;
	date: string;
	source: string;
	repeat?: number;
	traceId?: string; // the request this line was written for
}

export interface ILogService {
	name: string;
	count: number;
}

export interface ILogResponse {
	// The backend may return either a plain list of service names or
	// {name,count} pairs depending on version, so accept both.
	services: (string | ILogService)[];
	log: ILogItem[];
}

// Ordered from most verbose to most severe, mirroring the backend logMap.
export const LOG_LEVELS = ["ALL", "API", "INFO", "DB", "WARN", "ERROR", "CRIT"] as const;
export type TLogLevel = (typeof LOG_LEVELS)[number];

export interface IMemoryUsage {
	rss: number; // MB
	heapUsed: number; // MB
	heapTotal: number; // MB
	external: number; // MB
}

export interface IMonitorSlot {
	yyyymmddhhii: number;
	cpu: number; // percent (0-100) per core
	memory: IMemoryUsage;
	externalCalls?: number;
	successEp: Record<string, number>;
	failEp: Record<string, number>;
	http: Record<string, number>;
	// Per-slot SQL query counters, keyed by query template. Optional because
	// they are populated only when the backend has DB instrumentation enabled.
	success_sql?: Record<string, number>;
	fail_sql?: Record<string, number>;
	// Newer per-host outgoing metrics (per-minute counts + p95 latency).
	// Missing on slots produced before the backend upgrade — charts must
	// render gaps for those minutes rather than 0.
	http_ok?: Record<string, number>;
	http_fail?: Record<string, number>;
	httpP95?: Record<string, number>;
}

export interface IStat {
	timestamp: number;
	slot: IMonitorSlot;
}

// Historical metrics archived to disk in weekly buckets. Each key is an ISO
// week identifier like "2026-W36" — the current live week is minute-resolution,
// older archives are hour-resolution. Backend responds with a plain string[]
// (metricsWeeks) or IStat[] (metricsWeek) — same slot shape as live metrics.
export type TWeekKey = string;

// File logs on disk (Monitor.logfiles / logtail). The client only ever picks a
// source id — the backend resolves the path, so arbitrary files can't be read.
export type TLogSourceId = "process-out" | "process-err" | "nginx-access" | "nginx-error";

export interface ILogFileSource {
	id: TLogSourceId;
	label: string;
	path: string | null;
	configured: boolean;
	exists: boolean;
	readable: boolean;
	size?: number;
	modifiedAt?: number;
	reason: string | null;
}

export interface ILogTailResult {
	source: TLogSourceId;
	path: string;
	size: number;
	cursor: number; // pass back as `since` to receive only new lines
	rotated: boolean; // file rotated/truncated → clear and show the fresh tail
	truncated: boolean; // >512KB appended since last call → middle skipped
	lines: string[];
}

// Live snapshot of the server's outgoing HTTP connections (Http.getActiveConnectionsSnapshot).
export interface IConnectionsSnapshot {
	total: number;
	byHost: Record<string, number>;
}

// Aggregated outgoing HTTP statistics (Http.getHttpStats).
export interface IHttpStatusDistribution {
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
	other: number;
	networkErrors: number;
	timeouts: number;
}

export interface IHttpHostStats {
	host: string;
	count: number;
	errors: number; // !ok (non-2xx or network error)
	timeouts: number; // subset of errors
	retries: number; // sum of (attempts - 1)
	avgMs: number;
	minMs: number;
	maxMs: number;
	// Percentiles over the last ~1024 requests to this host — always "fresh".
	// p95Ms is the key signal for early partner-degradation detection.
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	totalTimeMs: number;
	inFlight: number;
	byStatus: { s2xx: number; s3xx: number; s4xx: number; s5xx: number; other: number; networkErrors: number };
	lastRequestAt: number;
}

export interface IHttpStats {
	totalRequests: number;
	inFlight: { current: number; peak: number; byHost: Record<string, number> };
	statusDistribution: IHttpStatusDistribution;
	perHost: IHttpHostStats[];
	topSlow: IOutgoingNetLogItem[];
}

// Outgoing HTTP request log entry (Http.getOutgoingLogSnapshot).
export interface IOutgoingNetLogItem {
	id: number;
	created: number;
	time: number;
	method: string;
	url: string;
	status?: number;
	ok: boolean;
	attempts: number;
	request: unknown;
	response: unknown;
	error?: string;
	traceId?: string; // the incoming request this call was made for
	skipLogging?: true; // made with skipLogging: url is only the origin, bodies are not kept
}

// Inventory of registered services and endpoints (Monitor.inventory).
export interface IInventoryHandler {
	path: string;
	methods: string[];
	ignoreInterceptor: boolean;
	ignoreInDocumentation: boolean;
	ignoreHttpLogging: boolean;
	independed: boolean;
	asStream: boolean;
	hasValidationModel: boolean;
	hasResultModel: boolean;
	description?: string;
	title?: string;
}

export interface IInventoryEndpoint {
	className: string;
	basePath: string;
	ignoreHttpLogging: boolean;
	ignoreInDocumentation: boolean;
	description?: string;
	createdAt: number;
	initializedAt: number | null;
	handlerCount: number;
	handlers: IInventoryHandler[];
}

export interface IInventoryService {
	className: string;
	name: string;
	initialized: boolean;
	createdAt: number;
	initializedAt: number | null;
	applicationReadyAt: number | null;
	uptimeSec: number | null;
}

export interface IInventory {
	services: IInventoryService[];
	endpoints: IInventoryEndpoint[];
	counts: { services: number; endpoints: number; totalHandlers: number };
	entrypoint: string;
}

// System-level snapshot (collectSystemInfo).
export interface ISysInfo {
	cpu: {
		count: number;
		models: Record<string, number>;
		loadAvg: number[];
		platform: string;
		arch: string;
		uptimeSec: number;
		usage: { userPct: number; systemPct: number; idlePct: number; iowaitPct: number } | null;
	};
	memory: { total: number; free: number; used: number; usedPct: number };
	disk:
		| Array<{ filesystem: string; size: number; used: number; available: number; usePct: string; mount: string }>
		| null;
	connections: { ports: number[]; total: number; topRemote: { ip: string; count: number }[] } | null;
	nginx: {
		installed: boolean;
		version?: string;
		status?: string;
		listening?: string[];
		workerCount?: number;
		error?: string;
	};
	pm2: {
		installed: boolean;
		error?: string;
		processes?: Array<{
			name: string;
			pid: number;
			pm_id: number;
			status: string;
			uptime?: number;
			restarts?: number;
			cpu?: number;
			memory?: number;
			exec_mode?: string;
			instances?: number;
			node_version?: string;
		}>;
	};
}

// pm2 identity injected via env — present in identity when the process is
// managed by pm2 (has PM2_HOME/pm_id). `managed` is false otherwise.
export interface IProcPm2 {
	managed: boolean;
	name: string | null;
	pmId: string | null;
	instanceId: string | null;
	execPath?: string;
	cwd?: string;
}

// Response of POST sm/restart on success.
export interface IRestartResponse {
	restarting: boolean;
	name: string;
	pmId: string;
	by: string;
	graceMs: number;
}

// Process-level snapshot (ProcessMonitor.getSnapshot).
export interface IProcInfo {
	identity: {
		pid: number;
		ppid?: number;
		title?: string;
		argv?: string[];
		execPath?: string;
		cwd?: string;
		nodeVersion: string;
		v8Version: string;
		platform: string;
		arch: string;
		hostname: string;
		user: { uid: number; gid: number } | null;
		startedAtUnix: number;
		uptimeSec: number;
		availableParallelism: number;
		pm2?: IProcPm2;
	};
	memory: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
		arrayBuffers: number;
		heap: {
			sizeLimit: number;
			usedHeap: number;
			totalAvailable: number;
			totalPhysical: number;
			mallocedMemory: number;
			peakMallocedMemory: number;
			numberOfNativeContexts: number;
			numberOfDetachedContexts: number;
		};
		heapSpaces: Array<{ name: string; size: number; used: number; available: number; physical: number }>;
		procStatus?: Record<string, number> | null;
	};
	cpu: {
		userPct: number;
		systemPct: number;
		userMicros: number;
		systemMicros: number;
		resource: {
			maxRSS: number;
			voluntaryContextSwitches: number;
			involuntaryContextSwitches: number;
			fsRead: number;
			fsWrite: number;
			signalsCount: number;
			ipcSent: number;
			ipcReceived: number;
			userCPUTimeMs: number;
			systemCPUTimeMs: number;
		} | null;
	};
	eventLoop: {
		minMs: number;
		maxMs: number;
		meanMs: number;
		stddevMs: number;
		p50Ms: number;
		p90Ms: number;
		p99Ms: number;
		utilizationPct: number;
		activeHandles: number;
		activeRequests: number;
		spotLagMs: number;
	} | null;
	gc: {
		totalCount: number;
		totalTimeMs: number;
		maxPauseMs: number;
		byKind: Record<string, { count: number; timeMs: number }>;
		lastPauses: Array<{ kind: string; ms: number; timestamp: number }>;
	};
	fileDescriptors: { open: number | null; limitSoft: number | null; limitHard: number | null };
}

// HTTP request log entry (APIServiceNetworkLogItem).
export interface INetLogItem {
	id: number;
	created: number; // epoch ms
	time: number; // response time, ms
	referer?: string;
	error?: string | null;
	request?: {
		endpoint?: string;
		method?: string;
		headers?: Record<string, string>;
		params?: Record<string, unknown>;
		data?: unknown;
		interceptorResult?: unknown;
	};
	response?: unknown;
	traceId?: string;
}

// Database health (DBService.healthcheck) — one entry per DB instance.
export interface IDbLongQuery {
	query: string;
	execution: number; // ms
}

export interface IDbPoolStatus {
	lastSuccessQueryTime: string;
	poolConnections: number;
	acquiredPoolConnections: number;
}

export interface IDbStatFrame {
	slot: number; // yyyymmddhhmm minute key
	transactionsCount: number;
	totalQueries: number;
	failedQueries: number;
	averageQueryTime: number; // ms
	minQueryTime: number; // ms
	maxQueryTime: number; // ms
	longestQueries: IDbLongQuery[];
}

export interface IDbHealth {
	id: string;
	host: string;
	port: number;
	poolStatus: IDbPoolStatus | null;
	stat: IDbStatFrame[] | null;
}

// Aggregated per-endpoint counters derived from a series of slots.
export interface IEndpointStat {
	endpoint: string;
	success: number;
	fail: number;
	total: number;
}

// File-descriptor / socket leak report (ProcessMonitor.getFdReport).
// Backend collects it from /proc — `sockets` is null on non-Linux platforms.
export interface IFdSocketByState {
	ESTABLISHED?: number;
	SYN_SENT?: number;
	SYN_RECV?: number;
	FIN_WAIT1?: number;
	FIN_WAIT2?: number;
	TIME_WAIT?: number;
	CLOSE?: number;
	CLOSE_WAIT?: number;
	LAST_ACK?: number;
	LISTEN?: number;
	CLOSING?: number;
	NEW_SYN_RECV?: number;
	[state: string]: number | undefined;
}

export interface IFdSocketsSnapshot {
	total: number;
	byState: IFdSocketByState;
	topRemotes: Array<{ host: string; established: number }>;
}

export interface IFdNowSnapshot {
	ts: number;
	fdOpen: number;
	limitSoft: number | null; // -1 means "unlimited"; null on non-Linux
	limitHard: number | null;
	sockets: IFdSocketsSnapshot | null;
}

export interface IFdHistoryEntry {
	ts: number;
	fdOpen: number;
	fdSoftLimit: number | null;
	socketTotal: number | null;
	byState: IFdSocketByState;
	topRemote: { host: string; established: number } | null;
	rss: number;
}

export interface IFdReport {
	now: IFdNowSnapshot;
	sampleEveryMs: number;
	historyMax: number;
	history: IFdHistoryEntry[];
}

// Probing / attack attempts per client IP (Monitor.threats). Observation only —
// the server never blocks. Scores decay (half-life ~30 min).
export type TThreatCategory = "scanner" | "injection" | "enumeration" | "auth" | "method" | "not-found";
export type TThreatLevel = "none" | "suspicious" | "high";

export interface IThreatSample {
	ts: number;
	method: string;
	url: string; // already masked server-side
	status: number;
	categories: TThreatCategory[];
}

export interface IThreatOffender {
	ip: string;
	score: number;
	level: TThreatLevel;
	firstSeen: number;
	lastSeen: number;
	hits: number;
	categories: Partial<Record<TThreatCategory, number>>;
	userAgent?: string;
	samples: IThreatSample[];
	blocked?: boolean;
}

export interface IThreatEvent extends IThreatSample {
	ip: string;
	score: number;
}

export interface IThreats {
	generatedAt?: number;
	settings: { halfLifeMinutes: number; suspiciousAt: number; highAt: number };
	totals: { tracked: number; suspicious: number; high: number };
	offenders: IThreatOffender[];
	recent: IThreatEvent[];
}

// ---- IP blocking (block / unblock / blocked) ----

export interface IBlockEntry {
	ip: string;
	reason?: string;
	until?: string | null; // ISO; empty/null = forever
	by?: string;
	at?: string;
	active: boolean; // false = expired
}

export interface IBlockedList {
	file?: string;
	entries: IBlockEntry[];
	hits: Record<string, number>; // rejected requests since process start
}
