// The public API of @bmfk/api. Everything an application may use is exported from here; package.json
// "exports" closes every other path, so whatever is not listed is internal and may change in any release.

// Application and HTTP server
export { APIService, Initializer, getDefaultOptions, REQ_HTTP_LOG, REQ_HTTP_REQUESTS_COUNT, REQ_HTTP_SERVER, REQ_INTERNAL_CALL, REQ_WS_SERVER, S_APP_STARTED } from "./apiServer/APIService";
export type { APIServiceOptions, APIServiceNetworkLogItem, IInterceptor, IMonitorUser, IDocumentationUser, IDeployerUser, IWebSocketServerOptions } from "./apiServer/APIService";
export { BaseService } from "./apiServer/BaseService";
export type { IBaseService } from "./apiServer/BaseService";
export { BaseEndpoint } from "./apiServer/BaseEndpoint";
export type { IBaseEndpoint, IHandler, IEndpointHandler } from "./apiServer/BaseEndpoint";
export { LocalRequest } from "./apiServer/LocalRequest";
export type { IRequest, IResponse, IError, HTTPRequestVO, TransferPacketVO } from "./apiServer/structures/Interfaces";
export { default as DefaultErrors, ErrorUtils } from "./apiServer/structures/DefaultErrors";

// Validation
export { Validator, ValidationModel, ValidationReport } from "./apiServer/helper/Validator";
export type { TValidatorType, IStructureOptions, IValidatorOptions } from "./apiServer/helper/Validator";

// Interceptors
export { InterceptorSignedAuth } from "./apiServer/interceptors/InterceptorSignedAuth";
export type { ISignedAuthResult, ISignedAuthVerdict } from "./apiServer/interceptors/InterceptorSignedAuth";
export { InterceptorPayAuth } from "./apiServer/interceptors/InterceptorPayAuth";
export type { IPayAuthKey } from "./apiServer/interceptors/InterceptorPayAuth";

// Logging and tracing
export { LogService, LOG_LEVEL, getDefaultLogOptions, logInfo, logWarn, logError, logCrit, logDB, logAPI, S_LOG, REQ_LOG } from "./apiServer/LogService";
export type { ILogItem, ILogServiceOptions } from "./apiServer/LogService";
export { Trace, TRACE_HEADER } from "./apiServer/helper/Trace";

// Database
export { DBService, REQ_DB, REQ_DBX, REQ_DB_TBEGIN, REQ_DB_TCOMMIT, REQ_DB_TROLLBACK, dbField } from "./apiServer/DBService";
export type { IDBQuery, IDBQueryField, IDBQueryFields, IDBField, IDBBulkQuery, IDBBulkQueryItem, IDBError, IDBResult, IDBSericeOptions, DBAdapterOptions } from "./apiServer/DBService";
export { MysqlAdapter, isError as isDBError } from "./apiServer/db/MysqlAdapter";
export { PostgresAdapter } from "./apiServer/db/PostgresAdapter";
export type { IDBAdapter } from "./apiServer/db/IDBAdapter";

// Outgoing HTTP
export { Http } from "./apiServer/http/Http";
export type { HttpMethod, THttpResult, THttpOk, THttpErr, THttpConfig, TRequestOptions, TRetryPolicy } from "./apiServer/http/Http";

// Microservices
export { MicroserviceHost, MemoryJobStore } from "./apiServer/external/MicroserviceHost";
export type { IMicroserviceHostOptions, IMicroserviceCaller, IMicroserviceCall, IMicroserviceJob, IMicroserviceJobStore } from "./apiServer/external/MicroserviceHost";
export { MicroserviceClient, REQ_MICROSERVICE_CALL } from "./apiServer/external/MicroserviceClient";
export type { IMicroserviceClientOptions } from "./apiServer/external/MicroserviceClient";

// WebSocket
export { WebSocketServer, WebSocketConnection, S_WS_ON_CONNECTED, S_WS_ON_MESSAGE, S_WS_ON_CLOSE, WS_CLOSE_UNAUTHORIZED, WS_CLOSE_AUTH_TIMEOUT, WS_CLOSE_RATE_LIMIT, WS_CLOSE_INTERNAL } from "./apiServer/WebSocketServer";
export type { WebSocketAuthorizer } from "./apiServer/WebSocketServer";

// Scheduling
export { TimeframeService, REQ_TIMEFRAME_TASK_ADD, S_TIMEFRAME_TASK_EXECUTED } from "./apiServer/TimeframeService";
export type { ITimeframeTask } from "./apiServer/TimeframeService";

// Monitor and process
export { S_MONITOR_REGISTRATE_ACTION, S_MONITOR_RESTART_REQUESTED } from "./apiServer/monitor/Monitor";
export { ProcessMonitor } from "./apiServer/monitor/ProcessMonitor";
export type { IAccess } from "./apiServer/monitor/AccessStore";

// Deployment and blue-green
export { Deploy } from "./apiServer/deployment/Deploy";
export { Activate } from "./apiServer/deployment/Activate";
export { S_BLUEGREEN_STATE_CHANGED, onLiveChange, getBlueGreenActiveState, getBlueGreenStateSync } from "./apiServer/deployment/BlueGreenState";
export type { IBlueGreenState, IBlueGreenStateOptions } from "./apiServer/deployment/BlueGreenState";

// Signals
export { Signal, Req } from "./signal/Signal";

// Helpers
export { DataProvider } from "./apiServer/helper/DataProvider";
export { UID } from "./apiServer/helper/UID";
export { YYYYMMDDHH, YYYYMMDDHH_toDate } from "./apiServer/helper/YYYYMMDDHH";
export { JSONStableStringify } from "./apiServer/helper/JSONStableStringify";
export { ZipUtils } from "./apiServer/helper/ZipUtils";
