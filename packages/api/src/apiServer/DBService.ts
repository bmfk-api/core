
import { Req } from "../signal/Signal";
import { BaseService } from "./BaseService";
import { IDBAdapter } from "./db/IDBAdapter";
import { MysqlAdapter } from "./db/MysqlAdapter";
import { logDB } from "./LogService";
import { PostgresAdapter } from "./db/PostgresAdapter";
import type { IDBField } from "./db/DBField";
export { dbField } from "./db/DBField";
export type { IDBField } from "./db/DBField";


export interface IDBQueryField {
    name?: string | null,
    value: string | number | boolean | Date | null | undefined,
    system?: boolean,
    ignoreInInsert?: boolean,
    ignoreInUpdate?: boolean,
    useInReplace?: boolean
    __parsedValue?: string | number | boolean | null | undefined,
    fields?:Record<string,number|boolean|string|null>
}

// A plain object or array is a value (stored as JSON); options only through dbField().
export interface IDBQueryFields {
    [key: string]: string | number | boolean | Date | IDBField | Record<string, unknown> | unknown[] | null | undefined
}

export interface IDBQuery {
    dbid?: string,
    query: string,
    fields?: IDBQueryFields,
    throwable?: boolean
    onDuplicateErrorText?: string
    onErrorText?: string
    transactionID?: number
    rollbackOnFail?: boolean
    calculateCount?: boolean
    parseQueryOnly?: boolean
    debug?: boolean
}
export interface IDBBulkQueryItem {
    query: string,
    fields: IDBQueryFields,
    throwable?: boolean
    calculateCount?: boolean
}

export interface IDBBulkQuery {
    dbid?: string,
    bulk: IDBBulkQueryItem[],
    queued?: boolean
}

export interface IDBError {
    code: string,
    errno: number,
    fatal: boolean,
    sql: string,
    name: string,
    message: string,
    isDuplicateError: boolean
}

export interface IDBResult {
    data?: any | null,
    error?: IDBError | null
    total?: number,
    execution: {
        started_at: number,
        finished_at: number
    }
}

export interface IDBSericeOptions {
    id: string,
    type: "mysql" | "postgres",
    connection: DBAdapterOptions
}

export interface DBAdapterOptions {
    connectionLimit: number,
    host: string,
    user: string,
    password: string,
    port: number,
    database: string,
    connectionParamers?: string,
    idleTimeoutMillis?: number,
    connectionTimeoutMillis?: number,
    queueLimit?: number,
    transactionFailReport?: (trx: any, message: string) => void,
    transactionFailReportDir?: string,
    maxTransactionWaitTime?: number,
    maxQueryTimeout?:number,
    debug?: boolean
}

export interface IPoolStatus{
    lastSuccessQueryTime:string,
    poolConnections:number,
    acquiredPoolConnections:number
}

export interface IDBStatFrame {
 transactionsCount:number,
 averageQueryTime: number;
 totalQueries: number;
 maxQueryTime: number;
 minQueryTime: number;
 failedQueries: number;
 longestQueries: {query:string,execution:number}[];
}

export const REQ_DB = new Req<IDBQuery, IDBResult>(undefined, "REQ_DB");
export const REQ_DBX = new Req<IDBBulkQuery, IDBResult[]>(undefined, "REQ_DBX");
export const REQ_DB_TBEGIN = new Req<{ dbid: string }, IDBResult>(undefined, "REQ_DB_TBEGIN")
export const REQ_DB_TCOMMIT = new Req<{ dbid: string, trxid: number }, IDBResult>(undefined, "REQ_DB_TCOMMIT")
export const REQ_DB_TROLLBACK = new Req<{ dbid: string, trxid: number }, IDBResult>(undefined, "REQ_DB_TROLLBACK")

export class DBService extends BaseService {

    static allInstances: DBService[] = [];
   
    options: IDBSericeOptions;
    adapter: IDBAdapter | null = null;

    

    constructor(options: IDBSericeOptions) {
        super("DB Service");
        this.options = options;
        if (DBService.allInstances.length > 0) {
            for (let i of DBService.allInstances) {
                if (i.options.id === options.id)
                    throw { code: -1, message: "DBService duplicate id: " + options.id }
            }
        }
        DBService.allInstances.push(this);
    }

    async init() {
        super.init();

        if (this.options.type === "mysql") {
            await this.createMysqlDatabase()
        }

        if(this.options.type === "postgres"){
            this.adapter = new PostgresAdapter(this.options.connection);
        }

        REQ_DBX.listener = async (req) => {
            const executionStartTime = Date.now()
            // only one db instance
            if (!req.dbid && DBService.allInstances.length === 1 && DBService.allInstances[0].adapter){
                return await DBService.allInstances[0].adapter.bulk(req);
            }

            // multiple db instances
            for (let i of DBService.allInstances) {
                if (i.options.id === req.dbid && i.adapter){
                    return await i.adapter.bulk(req);
                }
            }

            const error: IDBError = {
                code: "DB_NOT_FOUND",
                errno: -1,
                fatal: true,
                sql: "",
                name: "DB_NOT_FOUND",
                message: "DB not found: " + req.dbid,
                isDuplicateError: false

            }

            let result = [];
            for (let i of req.bulk) {
                result.push({
                    error: error, execution: {
                        started_at: executionStartTime,
                        finished_at: Date.now()
                    }
                });
                if (i.throwable)
                    throw error;
            }

            return result;

        }

        REQ_DB_TBEGIN.listener = async (req) => {
            const executionStartTime = Date.now()
            const adapter = this.getAdapter(req.dbid);
            if ("errno" in adapter) {
                return {
                    error: adapter, execution: {
                        started_at: executionStartTime,
                        finished_at: Date.now()
                    }
                }
            }

            if (adapter.tBegin && typeof adapter.tBegin === "function")
                return await adapter.tBegin()
            return {
                error: {
                    errno: -10,
                    code: "TRX_NOT_SUPPORTED",
                    fatal: true,
                    sql: "START TRANSACTION",
                    name: "TRX_NOT_SUPPORTED",
                    message: "Transactions not supported on selected adapter",
                    isDuplicateError: false
                }, execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        }

        REQ_DB_TCOMMIT.listener = async (req) => {
            const executionStartTime = Date.now()
            const adapter = this.getAdapter(req.dbid);
            if ("errno" in adapter) {
                return {
                    error: adapter, execution: {
                        started_at: executionStartTime,
                        finished_at: Date.now()
                    }
                }
            }

            if (adapter.tCommit && typeof adapter.tCommit === "function")
                return await adapter.tCommit(req.trxid)
            return {
                error: {
                    errno: -10,
                    code: "TRX_NOT_SUPPORTED",
                    fatal: true,
                    sql: "COMMIT",
                    name: "TRX_NOT_SUPPORTED",
                    message: "Transactions not supported on selected adapter",
                    isDuplicateError: false
                }, execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        }

        REQ_DB_TROLLBACK.listener = async (req) => {
            const executionStartTime = Date.now()
            const adapter = this.getAdapter(req.dbid);
            if ("errno" in adapter) {
                return {
                    error: adapter, execution: {
                        started_at: executionStartTime,
                        finished_at: Date.now()
                    }
                }
            }

            if (adapter.tRollback && typeof adapter.tRollback === "function")
                return await adapter.tRollback(req.trxid)
            return {
                error: {
                    errno: -10,
                    code: "TRX_NOT_SUPPORTED",
                    fatal: true,
                    sql: "ROLLBACK",
                    name: "TRX_NOT_SUPPORTED",
                    message: "Transactions not supported on selected adapter",
                    isDuplicateError: false
                }, execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        }


        REQ_DB.listener = async (req) => {

            // No copy of req.fields: the adapter doesn't change them, and structuredClone would drop
            // the mark of every dbField().
            const executionStartTime = Date.now()
            // only one db instance
            if (!req.dbid && DBService.allInstances.length === 1 && DBService.allInstances[0].adapter){
               return await DBService.allInstances[0].adapter.query(req);
            }

            // multiple db instances
            for (let i of DBService.allInstances) {
                if (i.options.id === req.dbid && i.adapter){
                    return await i.adapter.query(req);
                }
            }

            const error = {
                code: "DB_NOT_FOUND",
                errno: -1,
                fatal: true,
                sql: "",
                name: "DB_NOT_FOUND",
                message: "DB not found: " + req.dbid,
                isDuplicateError: false
            }

            const errorResult = {
                error: error, execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            };


            if (req.throwable)
                throw error;
            
            return errorResult;
        }
    }

    static escape(id:string,value:any): string{
        const adapter = DBService.allInstances.find(i=>i.options.id === id)?.adapter;
        if (!adapter || "errno" in adapter){
          
            if (value === null || value === undefined) return 'NULL';
    
            // Если это объект (JSON), сначала превращаем в строку
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

            // Экранируем спецсимволы для MySQL. "%" не трогаем: вне LIKE MySQL оставляет "\%"
            // как есть, и строка портилась (так же делает mysql.escape).
            return "'"+stringValue.replace(/[\0\x08\x09\x1a\n\r"'\\]/g, (char) => {
                switch (char) {
                    case "\0": return "\\0";
                    case "\x08": return "\\b";
                    case "\x09": return "\\t";
                    case "\x1a": return "\\z";
                    case "\n": return "\\n";
                    case "\r": return "\\r";
                    case "\"":
                    case "'":
                    case "\\":
                        return "\\" + char; // Экранируем через обратный слэш
                    default: return char;
                }
            }) + "'";
        }

        return adapter.escape(value);
    }

    getAdapter(dbid?: string | null): IDBAdapter | IDBError {
        // only one db instance
        if (!dbid && DBService.allInstances.length === 1 && DBService.allInstances[0].adapter)
            return DBService.allInstances[0].adapter;

        // multiple db instances
        for (let i of DBService.allInstances) {
            if (i.options.id === dbid && i.adapter)
                return i.adapter
        }

        const error = {
            code: "DB_NOT_FOUND",
            errno: -1,
            fatal: true,
            sql: "",
            name: "DB_NOT_FOUND",
            message: "DB not found: " + dbid,
            isDuplicateError: false
        }

        return error
    }

    static healthcheck(range: "hour" | "day" | "week" = "hour"): {
        id: string,
        host: string,
        port: number,
        poolStatus: IPoolStatus | null,
        stat: (IDBStatFrame & { slot: number })[] | null
    }[] {
        return DBService.allInstances.map(i => {
            const frames = i.adapter?.stat();
            const stat = frames ? DBService.aggregateStat(frames, range) : null;
            return {
                id: i.options.id,
                host: i.options.connection.host,
                port: i.options.connection.port,
                poolStatus: i.adapter?.poolStatus() ?? null,
                stat
            };
        });
    }

    /**
     * Свернуть минутные слоты статистики в чанки по step минут, ограничить limit минутами от конца.
     * step/limit подобраны как в MonitorService.getEPStat.
     */
    private static aggregateStat(
        frames: Map<number, IDBStatFrame>,
        range: "hour" | "day" | "week"
    ): (IDBStatFrame & { slot: number })[] {
        const steps = { hour: 1, day: 10, week: 30 };
        const limits = { hour: 60, day: 1440, week: 7200 };
        const step = steps[range];
        const limit = limits[range];

        const sorted = Array.from(frames.entries()).sort(([a], [b]) => a - b);
        const limited = sorted.slice(-limit);

        const result: (IDBStatFrame & { slot: number })[] = [];
        for (let i = 0; i < limited.length; i += step) {
            const chunk = limited.slice(i, i + step);

            let totalQueries = 0;
            let failedQueries = 0;
            let transactionsCount = 0;
            let weightedAvgSum = 0; // sum(avg * count) для взвешенного среднего
            let maxQueryTime = 0;
            let minQueryTime = Infinity;
            const merged: { query: string, execution: number }[] = [];

            for (const [, frame] of chunk) {
                totalQueries += frame.totalQueries;
                failedQueries += frame.failedQueries;
                transactionsCount += frame.transactionsCount;
                weightedAvgSum += frame.averageQueryTime * frame.totalQueries;
                if (frame.maxQueryTime > maxQueryTime) maxQueryTime = frame.maxQueryTime;
                if (frame.totalQueries > 0 && frame.minQueryTime < minQueryTime)
                    minQueryTime = frame.minQueryTime;
                if (frame.longestQueries.length)
                    merged.push(...frame.longestQueries);
            }

            merged.sort((a, b) => b.execution - a.execution);

            result.push({
                slot: chunk[0][0],
                transactionsCount,
                totalQueries,
                failedQueries,
                averageQueryTime: totalQueries > 0 ? weightedAvgSum / totalQueries : 0,
                maxQueryTime,
                minQueryTime: minQueryTime === Infinity ? 0 : minQueryTime,
                longestQueries: merged.slice(0, 5)
            });
        }

        return result;
    }

    async finishService() {
        await this.adapter?.finish();
    }

    async createMysqlDatabase() {
        this.adapter = new MysqlAdapter(this.options.connection)
        await this.adapter.init()
    }


}