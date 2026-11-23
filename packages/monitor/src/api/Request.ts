import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { authForm, session } from "../services/Auth";
import {
	IBlockedList,
	IConnectionsSnapshot,
	IDbHealth,
	IFdReport,
	IHttpStats,
	IInventory,
	ILogFileSource,
	ILogResponse,
	ILogTailResult,
	INetLogItem,
	IOutgoingNetLogItem,
	IProcInfo,
	IRestartResponse,
	IStat,
	ISysInfo,
	IThreats,
	TLogLevel,
	TLogSourceId,
	TRange,
	TWeekKey,
} from "../types";

interface IEndpoint {
	method: "GET" | "POST";
	endpoint: string;
	ignoreToken?: boolean;
	data?: unknown;
	params?: string;
}

export interface IError {
	code: number;
	message: string;
	details?: string;
	stack?: { [key: string]: IError };
}

export interface IApiResponse<T = unknown> {
	error?: IError;
	httpStatus: number;
	data?: T;
}

// ---- session / 2FA ----

export type TCapability = "dashboard" | "logs" | "admin";

export interface ISession {
	token: string;
	login: string;
	idleTimeoutMs: number;
	maxLifetimeMs: number;
	twoFactor: boolean;
	role?: string;
	capabilities?: TCapability[];
}

export interface IEnrollmentRequired {
	enrollmentRequired: true;
	enrollmentToken: string;
	secret: string;
	otpauthUri: string;
	expiresInMs: number;
}

export const request_login = (req: {
	login: string;
	password: string;
	totp?: string;
}): Promise<IApiResponse<ISession | IEnrollmentRequired>> =>
	request<ISession | IEnrollmentRequired>({ method: "POST", endpoint: "login", data: req, ignoreToken: true });

export const request_enroll2fa = (req: { enrollmentToken: string; totp: string }): Promise<IApiResponse<ISession>> =>
	request<ISession>({ method: "POST", endpoint: "enroll2fa", data: req, ignoreToken: true });

export const request_logout = (): Promise<IApiResponse<{ ok: boolean }>> =>
	request<{ ok: boolean }>({ method: "POST", endpoint: "logout" });

// Auth layer registers this to bounce the operator to the login screen when a
// session dies mid-use (idle timeout / max lifetime / revoked).
let onUnauthorized: ((e: IError) => void) | null = null;
export const setUnauthorizedHandler = (fn: (e: IError) => void) => {
	onUnauthorized = fn;
};

export const request_log = (req: { lastID: number }): Promise<IApiResponse<ILogResponse>> =>
	request<ILogResponse>({ method: "POST", endpoint: "log", data: req });

export const request_metrics = (req: { range: TRange }): Promise<IApiResponse<IStat[]>> =>
	request<IStat[]>({ method: "POST", endpoint: "metrics", data: req });

// Archived weeks persisted on disk — enumerated as ISO week keys like "2026-W36".
// Empty array when the backend has no `metricsDir` configured.
export const request_metricsWeeks = (): Promise<IApiResponse<TWeekKey[]>> =>
	request<TWeekKey[]>({ method: "POST", endpoint: "metricsWeeks" });

export const request_metricsWeek = (req: { weekKey: TWeekKey }): Promise<IApiResponse<IStat[]>> =>
	request<IStat[]>({ method: "POST", endpoint: "metricsWeek", data: req });

export const request_netlog = (): Promise<IApiResponse<INetLogItem[]>> =>
	request<INetLogItem[]>({ method: "GET", endpoint: "netlog" });

export const request_connections = (): Promise<IApiResponse<IConnectionsSnapshot>> =>
	request<IConnectionsSnapshot>({ method: "POST", endpoint: "connections" });

export const request_db = (req: { range: TRange }): Promise<IApiResponse<IDbHealth[]>> =>
	request<IDbHealth[]>({ method: "POST", endpoint: "db", data: req });

export const request_outgoingNetlog = (): Promise<IApiResponse<IOutgoingNetLogItem[]>> =>
	request<IOutgoingNetLogItem[]>({ method: "POST", endpoint: "outgoingnetlog" });

export const request_sysinfo = (): Promise<IApiResponse<ISysInfo>> =>
	request<ISysInfo>({ method: "POST", endpoint: "sysinfo" });

export const request_procinfo = (): Promise<IApiResponse<IProcInfo>> =>
	request<IProcInfo>({ method: "POST", endpoint: "procinfo" });

export const request_fdreport = (): Promise<IApiResponse<IFdReport>> =>
	request<IFdReport>({ method: "POST", endpoint: "fdreport" });

// The server sends this response BEFORE process.exit(0) — the request
// resolves normally; any polling request that fires during the ~750ms grace
// or the pm2 respawn window will either error or hang until the new process
// is up. Callers should treat transient network errors after this as expected.
// Restart requires step-up re-authentication: password + TOTP again, even with
// a live session.
export interface IRestartRequest {
	confirm: string;
	password: string;
	totp?: string;
}

export const request_restart = (req: IRestartRequest): Promise<IApiResponse<IRestartResponse>> =>
	request<IRestartResponse>({ method: "POST", endpoint: "restart", data: req });

export const request_inventory = (): Promise<IApiResponse<IInventory>> =>
	request<IInventory>({ method: "POST", endpoint: "inventory" });

export const request_httpstats = (): Promise<IApiResponse<IHttpStats>> =>
	request<IHttpStats>({ method: "POST", endpoint: "httpstats" });

export const request_logfiles = (): Promise<IApiResponse<ILogFileSource[]>> =>
	request<ILogFileSource[]>({ method: "POST", endpoint: "logfiles" });

export interface ILogTailRequest {
	source: TLogSourceId;
	lines?: number;
	since?: number;
	filter?: string;
}

export const request_logtail = (req: ILogTailRequest): Promise<IApiResponse<ILogTailResult>> =>
	request<ILogTailResult>({ method: "POST", endpoint: "logtail", data: req });

export const request_threats = (req: { limit?: number }): Promise<IApiResponse<IThreats>> =>
	request<IThreats>({ method: "POST", endpoint: "threats", data: req });

export const request_blocked = (): Promise<IApiResponse<IBlockedList>> =>
	request<IBlockedList>({ method: "POST", endpoint: "blocked" });

// `hours` empty/0 = forever. `ip` may be a subnet (10.0.0.0/24).
export const request_block = (req: { ip: string; reason?: string; hours?: number }): Promise<IApiResponse<IBlockedList>> =>
	request<IBlockedList>({ method: "POST", endpoint: "block", data: req });

export const request_unblock = (req: { ip: string }): Promise<IApiResponse<IBlockedList>> =>
	request<IBlockedList>({ method: "POST", endpoint: "unblock", data: req });

export const request_changeLogLevel =(level: TLogLevel): Promise<IApiResponse<string>> =>
	request<string>({ method: "POST", endpoint: "changeLogLevel", data: { level } });

/**
 * Resolve the API base URL.
 * The `__host` injected by the backend when it serves index.html always wins.
 * The host entered in the login form is only a fallback for when the backend
 * did not inject one (e.g. local dev, where `__host` stays as `{{host}}`).
 * Falls back to a same-origin relative path when neither is set.
 */
const resolveBaseUrl = (): string => {
	const injected = (window as { __host?: string }).__host;

	let base = "/";
	if (injected && injected.trim() && !injected.includes("{{")) {
		base = injected.trim();
	} else if (authForm.host && authForm.host.trim()) {
		base = authForm.host.trim();
	}

	if (!base.endsWith("/")) base += "/";
	return base;
};

// While a restart is in progress the old process dies with every session in
// it, so polling gets 401s by design — the restart flow handles those itself.
let suppress401 = false;
export const setSuppressUnauthorized = (v: boolean) => {
	suppress401 = v;
};

const FORBIDDEN_TEXT = "You don't have permission for this action.";

const request = async <T = unknown>(ep: IEndpoint): Promise<IApiResponse<T>> => {
	const url = resolveBaseUrl() + ep.endpoint + (ep.params ? "?" + ep.params : "");
	const token = session.current?.token;

	const config: AxiosRequestConfig = {
		url,
		method: ep.method,
		responseType: "json",
		headers: {
			"Content-Type": "application/json",
			Authorization: !ep.ignoreToken && token ? "Bearer " + token : undefined,
		},
		data: ep.method !== "GET" ? ep.data : undefined,
	};

	let result: IApiResponse<T>;
	try {
		const resp = await axios(config);
		result = (resp.data ?? {}) as IApiResponse<T>;
		if (!result.httpStatus) result.httpStatus = resp.status;
	} catch (err) {
		const e = err as AxiosError<{ error?: IError; message?: string }>;
		const payload = e.response?.data;
		const status = e.response?.status ?? 0;
		if (payload && typeof payload === "object" && payload.error) result = { error: payload.error, httpStatus: status };
		else if (payload && typeof payload === "object" && payload.message)
			result = { error: { code: 999, message: payload.message }, httpStatus: status };
		else result = { error: { code: -1, message: "Network error: " + e.message }, httpStatus: status };
	}

	const err = result.error;
	if (err) {
		const status = result.httpStatus || err.code;
		// Normalise so every consumer can rely on error.code for 401/403.
		if (status === 401 || status === 403) err.code = status;
		if (status === 403 && !err.details) err.details = FORBIDDEN_TEXT;
		if (status === 401 && !ep.ignoreToken && !suppress401) onUnauthorized?.(err);
	}
	return result;
};
