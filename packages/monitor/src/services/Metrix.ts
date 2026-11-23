import { Req } from "ui/src/signals";
import {
	request_changeLogLevel,
	request_connections,
	request_db,
	request_fdreport,
	request_httpstats,
	request_inventory,
	request_log,
	request_metrics,
	request_metricsWeek,
	request_metricsWeeks,
	request_netlog,
	request_outgoingNetlog,
	request_procinfo,
	request_restart,
	request_sysinfo,
	request_threats,
} from "../api/Request";
import { IApiResponse, IRestartRequest } from "../api/Request";
import {
	IConnectionsSnapshot,
	IDbHealth,
	IFdReport,
	IHttpStats,
	IInventory,
	ILogResponse,
	INetLogItem,
	IOutgoingNetLogItem,
	IProcInfo,
	IRestartResponse,
	IStat,
	ISysInfo,
	IThreats,
	TLogLevel,
	TRange,
	TWeekKey,
} from "../types";

export const REQ_LOG = new Req<{ lastID: number }, IApiResponse<ILogResponse>>(req => request_log(req));

export const REQ_METRICS = new Req<{ range: TRange }, IApiResponse<IStat[]>>(req => request_metrics(req));

export const REQ_METRICS_WEEKS = new Req<void, IApiResponse<TWeekKey[]>>(() => request_metricsWeeks());

// See comment on REQ_RESTART for the mount-fire sentinel pattern.
export const REQ_METRICS_WEEK = new Req<{ weekKey: TWeekKey }, IApiResponse<IStat[]>>(req =>
	req?.weekKey
		? request_metricsWeek({ weekKey: req.weekKey })
		: Promise.resolve({ httpStatus: 0 } as IApiResponse<IStat[]>),
);

export const REQ_NETLOG = new Req<void, IApiResponse<INetLogItem[]>>(() => request_netlog());

export const REQ_CHANGE_LOG_LEVEL = new Req<TLogLevel, IApiResponse<string>>(level => request_changeLogLevel(level));

export const REQ_CONNECTIONS = new Req<void, IApiResponse<IConnectionsSnapshot>>(() => request_connections());

export const REQ_DB_HEALTH = new Req<{ range: TRange }, IApiResponse<IDbHealth[]>>(req => request_db(req));

export const REQ_OUTGOING_NETLOG = new Req<void, IApiResponse<IOutgoingNetLogItem[]>>(() => request_outgoingNetlog());

export const REQ_SYSINFO = new Req<void, IApiResponse<ISysInfo>>(() => request_sysinfo());

export const REQ_PROCINFO = new Req<void, IApiResponse<IProcInfo>>(() => request_procinfo());

export const REQ_INVENTORY = new Req<void, IApiResponse<IInventory>>(() => request_inventory());

export const REQ_HTTPSTATS = new Req<void, IApiResponse<IHttpStats>>(() => request_httpstats());

export const REQ_FDREPORT = new Req<void, IApiResponse<IFdReport>>(() => request_fdreport());

// Req.useRequest fires the worker once on mount with `initialRequest` (undefined
// by default) — see `Req.useRequest` in lib/signals. Guard against dereferencing
// undefined; the sentinel response is ignored by consumers.
export const REQ_RESTART = new Req<IRestartRequest, IApiResponse<IRestartResponse>>(req =>
	req?.confirm
		? request_restart(req)
		: Promise.resolve({ httpStatus: 0 } as IApiResponse<IRestartResponse>),
);

export const REQ_THREATS = new Req<{ limit?: number }, IApiResponse<IThreats>>(req => request_threats(req ?? {}));
