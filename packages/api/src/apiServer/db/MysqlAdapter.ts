import { DBAdapterOptions, IDBBulkQuery, IDBError, IDBQuery, IDBQueryField, IDBResult, IDBStatFrame } from "../DBService";
import { IDBAdapter, } from "./IDBAdapter";
import { isDBField, looksLikeFieldOptions } from "./DBField";
import mysql from 'mysql2/promise';
import fs from 'fs';
import { logDB, logCrit, logError, logInfo, logWarn } from "../LogService";
import DefaultErrors from "../structures/DefaultErrors";
import path from "path";
import { S_STAT_REGISTRATE_SQL_REQUEST } from "../MonitorService";
import { YYYYMMDDHH } from "../helper/YYYYMMDDHH";

interface ITransaction {
    id: number
    timestamp: number,
    conn: mysql.PoolConnection,
    queries: { sql: string, status: string }[]
}


export class MysqlAdapter implements IDBAdapter {
    options: DBAdapterOptions;
    serviceStarted: boolean = false;

    

    reconnectionTimeout = 1000 * 3;
    reconnecting = false;
    pool: mysql.Pool | null = null;
    timeoutID: any

    queries = []; // TODO: STORE QUERIES SENTS BEFORE THE SERVICE IS STARTED!


    static nextTransactionID = 1;
    transactions: ITransaction[] = []
    maxTransactionWaitTime = 1000 * 60 * 2; // 2 min and detelete transaction

    lastSuccessQueryTime = 0;
    pingInterval = 1000 * 60 * 5; // each 5 min

    failReportFileStream: fs.WriteStream | null = null;
    failReportFileStreamName: string | null = null;
    failReportLastAccessTime: number = 0;

    poolConnections: number = 0;
    acquiredPoolConnections: number = 0;

    statFrames: Map<number, IDBStatFrame> = new Map();


    constructor(options: DBAdapterOptions) {
        this.options = options;
    }

    escape(value: string): string{
        return mysql.escape(value)   
    }

    stat(){
        return this.statFrames
    }

    private statRetentionMs = 5 * 24 * 60 * 60 * 1000; // 5 days (matches "week" range in healthcheck aggregation)

    private getOrCreateStatSlot(date: Date = new Date()): IDBStatFrame {
        const key = parseInt(YYYYMMDDHH(date, "yyyymmddhhmm"));
        let slot = this.statFrames.get(key);
        if (slot)
            return slot;

        slot = {
            transactionsCount: 0,
            averageQueryTime: 0,
            totalQueries: 0,
            maxQueryTime: 0,
            minQueryTime: 0,
            failedQueries: 0,
            longestQueries: []
        };
        this.statFrames.set(key, slot);

        // cleanup slots older than retention window — only fires when a new slot is born
        const cutoff = parseInt(YYYYMMDDHH(new Date(date.getTime() - this.statRetentionMs), "yyyymmddhhmm"));
        for (const k of this.statFrames.keys()) {
            if (k < cutoff)
                this.statFrames.delete(k);
        }
        return slot;
    }

    collectStat(query: string, execTime: number, failed: boolean) {
        const slot = this.getOrCreateStatSlot();

        slot.totalQueries++;
        if (failed)
            slot.failedQueries++;

        // cumulative running average
        slot.averageQueryTime += (execTime - slot.averageQueryTime) / slot.totalQueries;

        if (slot.totalQueries === 1) {
            slot.maxQueryTime = execTime;
            slot.minQueryTime = execTime;
        } else {
            if (execTime > slot.maxQueryTime) slot.maxQueryTime = execTime;
            if (execTime < slot.minQueryTime) slot.minQueryTime = execTime;
        }

        // top-5 longest queries (query truncated to 100 chars)
        const truncated = query.length > 100 ? query.substring(0, 100) : query;
        if (slot.longestQueries.length < 5 || execTime > slot.longestQueries[slot.longestQueries.length - 1].execution) {
            slot.longestQueries.push({ query: truncated, execution: execTime });
            slot.longestQueries.sort((a, b) => b.execution - a.execution);
            if (slot.longestQueries.length > 5)
                slot.longestQueries.length = 5;
        }
    }

    collectTransactionStat() {
        this.getOrCreateStatSlot().transactionsCount++;
    }

    async init(): Promise<void> {

        // Create file for transaction porblem report
        if (this.options.transactionFailReportDir) {
            try {
                if (!fs.existsSync(this.options.transactionFailReportDir))
                    fs.mkdirSync(this.options.transactionFailReportDir);
            } catch (e) {
                this.options.transactionFailReportDir = undefined;
                logCrit("MysqlAdapter", "Can't create transaction fail report dir")
            }
        }

        // setup process exit handlers interrupt (ctrl+c)
        this.serviceStarted = false;
        let poolCreated: boolean = false;
        while (!poolCreated) {
            poolCreated = await this.recreatePool();
            if (!poolCreated) {
                logCrit("MysqlAdapter", "Can't connect to MYSQL! Retrying in 3 seconds...")
                await new Promise((resolve) => setTimeout(resolve, 3000)) // sleep 3 seconds
            }
        }

        this.setupTimers();
    }


    poolStatus(){
        return {
            lastSuccessQueryTime:new Date(this.lastSuccessQueryTime).toISOString(),
            poolConnections:this.poolConnections,
            acquiredPoolConnections:this.acquiredPoolConnections
        }
    }

    isCleanupRunning = false;
    setupTimers() {


        // Handle hanging transactions
        setInterval(async () => {
            if( this.isCleanupRunning){
                logError("MysqlAdapter", "Cleanup already running, skipping this iteration")
                return;
            }

            this.isCleanupRunning = true;
            try{
            // check transactions
            const now = Date.now();
            const count = this.transactions.length;
            const removedIDs: number[] = [];

            for (let i of this.transactions) {
                if (now - i.timestamp > this.maxTransactionWaitTime) {
                    logError("Release transaction connection due to timeout")
                    await this.rollbackTransaction(i, true);
                    removedIDs.push(i.id)
                }
            }

            this.transactions = this.transactions.filter(i => !removedIDs.includes(i.id))

            if (this.options.debug && count - this.transactions.length > 0)
                logDB("Removed: ", count - this.transactions.length)

            // PING SERVER
            if (this.pool && Date.now() - this.lastSuccessQueryTime > this.pingInterval) {
                for (let i = 0; i < this.options.connectionLimit; i++) {
                    this.query({ query: "SELECT 1 @NOLIMIT" })
                }
            }

            }finally{
                // Always cleared — an early exit used to leave it set, stopping cleanup for good.
                this.isCleanupRunning = false;
            }

        }, 1000 * 30)   


        


        setInterval(() => {
            if (!this.failReportFileStream)
                return;

            // after 15 min of inactivity, close file
            if (Date.now() - this.failReportLastAccessTime > 1000 * 60 * 15) {
                this.failReportFileStream.end();
                this.failReportFileStream = null;
            }

        }, 1000 * 60 * 5)
    }

    /** Create connection pool */
    async recreatePool(): Promise<boolean> {

        const opt = {
            host: this.options.host
            , user: this.options.user
            , password: this.options.password
            , database: this.options.database
            , port: this.options.port
            , connectionLimit: this.options.connectionLimit
            , queueLimit: this.options.queueLimit ?? 50
            , multipleStatements: true

            , enableKeepAlive: true
            , keepAliveInitialDelay: 3 * 1000
            //,maxIdle:0
            , idleTimeout: 1000 * 60 * 5
        }

        logDB("${MysqlAdapter.js}", "Connecting to mysql: \n " + JSON.stringify({ ...opt, password: "****" }, null, "\t"))

        if (this.pool) {
            this.pool.removeAllListeners();
            try { await this.pool.end(); } catch (e) {
                logCrit("MysqlAdapter", "Can't close MYSQL pool! " + e)
            }
            this.pool = null;
        }


        // Keep alive packets should be sent
        /*enableKeepAlive: true,
        // We should start sending them early
        keepAliveInitialDelay: 3 * 1000, // 3 seconds
        // We don't want idle connections, but it's not mandatory for the fix to work, it seems
        maxIdle: 0,
        // Idle timeout much larger than keep alive delay and much smaller than MySQL's timeout setting
        idleTimeout: 5 * 60 * 1000 // 5 minutes
        */

        try {
            this.pool = mysql.createPool(opt);
        } catch (e) {
            logCrit("MysqlAdapter", "Can't connect to MYSQL! " + e)
            return false;
        }


        // TODO watch for free pool connections
        this.poolConnections = 0;
        this.acquiredPoolConnections = 0;
        this.pool?.on('connection', (connection) => {
            logDB("MysqlAdapter", "pool -> connection created, total:" + this.poolConnections++)
        });
        this.pool?.on('acquire', (connection) => {
            this.acquiredPoolConnections++
        })
        this.pool?.on('release', (connection) => {
            this.acquiredPoolConnections--
        })
        this.pool?.on('enqueue', () => {
            logDB("MysqlAdapter", "pool -> waiting for available connection")
        })

       
        const res = await this.query({ query: "SELECT 1 @NOLIMIT" });

        if (res.error) {
            logCrit("MysqlAdapter", "pool -> check connection livenes was failed: " + res.error.message)
            return false;
        }

        return true;
    }


    async tBegin(): Promise<IDBResult> {
        const executionStartTime = Date.now()
        const conn = await this.getConnection();
        if (isError(conn))
            return {
                error: conn,
                execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }

        // find conn in transactions
        for (let i of this.transactions) {
            if (i.conn === conn) {
                logError("Selected connection is in transaction")
                return {
                    error: {
                        errno: 100005,
                        code: "CONN_IN_TRX",
                        fatal: true,
                        sql: "START TRANSACTION",
                        name: "CONN_IN_TRX",
                        message: "Selected connection already in transaction",
                        isDuplicateError: false
                    },
                    execution: {
                        started_at: executionStartTime,
                        finished_at: Date.now()
                    }
                }
            }
        }

        const trxid = MysqlAdapter.nextTransactionID++;
        if (this.options.debug)
            logDB("Begin transaction with id ", trxid)

        const result = await this.query({ query: "START TRANSACTION" }, conn)
        const trxRequest: ITransaction = {
            id: trxid,
            timestamp: Date.now(),
            conn: conn,
            queries: []
        }

        if (result.error) {
            logCrit("Can't start transaction! " + result.error.message)
            trxRequest.queries.push({ sql: "START TRANSACTION", status: "error" })
            await this.rollbackTransaction(trxRequest)
            return result;
        }
        trxRequest.queries.push({ sql: "START TRANSACTION", status: "ok" })
        this.transactions.push(trxRequest)
        this.collectTransactionStat();
        if (this.options.debug)
            logDB("Transactions pool: ", this.transactions.map(t => "id:" + t.id + ", queries: " + t.queries.length))
        return {
            data: { transactionId: trxid },
            execution: {
                started_at: executionStartTime,
                finished_at: Date.now()
            }
        };
    }


    async tCommit(trxid: number): Promise<IDBResult> {
        const executionStartTime = Date.now()
        const trx = this.transactions.find(i => i.id === trxid);
        if (!trx) {
            return {
                error: {
                    code: "NO_TRX",
                    errno: 100004,
                    fatal: true,
                    sql: "",
                    name: "NO_TRX",
                    message: "Transaction not found",
                    isDuplicateError: false
                },
                execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        }


        if (this.options.debug)
            logDB("Commit transaction:", trx.id)

     

        if (this.options.debug)
            logDB("Transaction pool:", this.transactions)

        const err = await this.commit(trx);

        if (err)
            return {
                error: err,
                execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        return {
            data: true,
            execution: {
                started_at: executionStartTime,
                finished_at: Date.now()
            }
        }
    }

    async tRollback(trxid: number): Promise<IDBResult> {
        const executionStartTime = Date.now()
        const trx = this.transactions.find(i => i.id === trxid);
        if (!trx) {
            return {
                error: {
                    code: "NO_TRX",
                    errno: 100004,
                    fatal: true,
                    sql: "",
                    name: "NO_TRX",
                    message: "Transaction not found",
                    isDuplicateError: false
                },
                execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        }

        /*await this.rollbackTransaction(trx);
        return {
            data: true,
            execution: {
                started_at: executionStartTime,
                finished_at: Date.now()
            }
        }*/

        const err = await this.rollbackTransaction(trx);

        if (err) {
            return {
                error: err,
                execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            };
        }

        return {
            data: true,
            execution: {
                started_at: executionStartTime,
                finished_at: Date.now()
            }
        };
    }

    async bulk(request: IDBBulkQuery): Promise<IDBResult[]> {
        const executionStartTime = Date.now()
        const results: IDBResult[] = [];
        let queries = [];

        let conn = null;
        
        if (request.queued) {
            conn = await this.getConnection();
            if (isError(conn)) {
                for (let i of request.bulk)
                    results.push({
                        data: null, error: conn,
                        execution: {
                            started_at: executionStartTime,
                            finished_at: Date.now()
                        }
                    })
                return results;
            }
        }

        for (let i of request.bulk) {

            // execute one by one
            if (request.queued && conn) {
                const response = await this.query({
                    query: i.query,
                    fields: i.fields,
                    throwable: i.throwable,
                }, conn)
                results.push(response);
                continue;
            }

            // execute all at once
            queries.push(this.query({
                query: i.query,
                fields: i.fields,
                throwable: i.throwable,
            }))
        }

        if (queries && queries.length > 0) {
            const responses = await Promise.all(queries);
            for (let i of responses)
                results.push(i)
        }

        if (conn) {
            this.finalizeConnection(conn);
            conn = null;
        }

        return results;
    }



    async getConnection(transactionId?: number): Promise<mysql.PoolConnection | IDBError> {

        // Check pool
        if (!this.pool) {
            logError("${MysqlAdapter.js}", "No pool created, can't execute query")
            return {
                code: "NO_POOL",
                errno: 100000,
                fatal: true,
                sql: "",
                name: "NO_POOL",
                message: "Mysql pool not created",
                isDuplicateError: false
            }
        }

        try {
            // get connection
            let conn: mysql.PoolConnection | null = null
            if (transactionId && transactionId > 0) {
                conn = this.transactions.find(i => i.id === transactionId)?.conn ?? null;
                if (this.options.debug)
                    logDB("Execute query on transaction: ", conn?.threadId)
            } else
                conn = await this.pool.getConnection();


            if (conn)
                return conn;

        } catch (e) {
            // recreate pool, connection error
            if (`${e}`.indexOf('ECONNREFUSED') !== -1 || `${e}`.indexOf("PROTOCOL_")!==-1 || `${e}`.includes("closed state")){
                logError("Connection looks dead, recreating pool 2")
                this.recreatePool();
            }
        }

        logCrit("${MysqlAdapter.js}", `No connection created!`)
        return {
            code: "NO_CONN",
            errno: 100001,
            fatal: true,
            sql: "",
            name: "NO_CONN",
            message: "Mysql pool cant get connection",
            isDuplicateError: false
        }
    }

    withTimeout<T>(promise: Promise<T>, ms: number,query:string): Promise<T> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject({
                    code:"TIME_OUT",
                    errno:100013,
                    sql:query,
                    name:"TIME_OUT",
                    fatal:true,
                    message:"Query timeout reached "+ms
                });
            }, ms);

            promise.then((res) => {
                clearTimeout(timeout);
                resolve(res);
            }).catch((err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

  
    async query(request: IDBQuery, conn?: mysql.PoolConnection): Promise<IDBResult> {

        let executionStartTime = Date.now()

        const query = this.prepareQuery(request);
        const isPing = query.trim().toLowerCase() === "select 1";
        if (this.options.debug || request.debug) {
            if (!isPing)
                logDB(query)
        }

        if (request.parseQueryOnly) {
            if(conn && !request.transactionID)
                this.finalizeConnection(conn);

            
            return {
                data: [{ query }],
                error: null,
                execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        }

        let doCloseConnection = false;
        if (!conn) {
            doCloseConnection = true;
            conn = await this.getConnection(request.transactionID ?? -1) as mysql.PoolConnection;
            if (isError(conn)) {
                
                return {
                    data: null,
                    error: conn,
                    execution: {
                        started_at: executionStartTime,
                        finished_at: Date.now()
                    }
                }
            }
        }


        let trx = null;
        if(request.transactionID)
            trx = this.transactions.find(i => i.id === request.transactionID);

        try {

            
            let result=null;
            if(this.options.maxQueryTimeout && this.options.maxQueryTimeout>0)
                result = await this.withTimeout(conn.query(query),this.options.maxQueryTimeout,query)
            else{
                result = await conn.query(query);
            }

            let total = null;;
            if(request.calculateCount){
               
                const cres = await conn.query(this.prepareCountQuery(query));
                              
                if(cres && cres[0]){
                    // result
                    const res=cres[0];
                    if(Array.isArray(res) && res.length>0 && "count" in res[0])
                        total = res[0].count;
                    else if("count" in res)
                        total = res.count;
                }
            }

            this.lastSuccessQueryTime = +new Date()

            // IF CONNECTION NOT IN TRANSACTION!
            if (!request.transactionID && doCloseConnection)
                this.finalizeConnection(conn);

            if(trx)
                trx.queries.push({sql:query,status:"ok"})

            const finishedAt = Date.now();
            if (!isPing) {
                S_STAT_REGISTRATE_SQL_REQUEST.invoke({success:true, query})
                this.collectStat(query, finishedAt - executionStartTime, false);
            }

            return {
                data: result[0],
                error: null,
                total: total ? total : undefined,
                execution: {
                    started_at: executionStartTime,
                    finished_at: finishedAt
                }
            }

        } catch (e) {

            if (!isPing) {
                S_STAT_REGISTRATE_SQL_REQUEST.invoke({success:false, query})
                this.collectStat(query, Date.now() - executionStartTime, true);
            }

            const timedOut = (e as any)?.code === "TIME_OUT";
            if (timedOut)
                this.killQuery(conn);

            if (!request.transactionID && doCloseConnection) {
                // A timed-out query may still be running on this connection: back in the pool it
                // would hand the next caller a busy connection. Drop it instead.
                if (timedOut) this.destroyConnection(conn);
                else this.finalizeConnection(conn);
            }

            else if (request.transactionID && request.throwable) {
                // force rollback, if query was failed & request was throwable
                await this.rollbackTransaction(this.transactions.find(i => i.id === request.transactionID) as ITransaction);
                //this.finalizeConnection(conn); // unnecessary, but just in case
            }

            if (request.transactionID && request.rollbackOnFail && !request.throwable) {
                // force rollback, if query was failed & request has rollbackOnFail
                await this.rollbackTransaction(this.transactions.find(i => i.id === request.transactionID) as ITransaction);
               //this.finalizeConnection(conn); // unnecessary, but just in case
            }

            const error = this.createMysqlQueryError(e);

             if(trx)
                trx.queries.push({sql:query,status:error.code})

            // recreate pool, connection error
            if (`${e}`.indexOf('ECONNREFUSED') !== -1 || `${e}`.indexOf("PROTOCOL_")!==-1 || error.message.includes("closed state")){
                logError("Connection looks dead, recreating pool 1")
                this.recreatePool();
            }

            // Skip the fail report for duplicate-key errors — they're expected business errors,
            // not transaction failures worth investigating.
            if(trx && !error.isDuplicateError)
                this.storeTransactionAsProblem(trx, "error:"+error.errno)

            if (request.throwable) {
                // The driver's message names tables, constraints and values: it goes to the log and
                // the stack (dropped in production), never into `details`, which the client gets.
                const base = error.isDuplicateError ? DefaultErrors.DB_DUPLICATE_ERROR : DefaultErrors.DB_ERROR;
                const customText = error.isDuplicateError ? request.onDuplicateErrorText : request.onErrorText;
                logError(`DB query failed: ${error.message}`);
                throw { ...base, ...(customText ? { message: customText } : {}), stack: error }
            }

            

            return {
                data: null,
                error: error,
                execution: {
                    started_at: executionStartTime,
                    finished_at: Date.now()
                }
            }
        }
    }



    // Our timeout only stops waiting; the server keeps executing. KILL QUERY (from another
    // connection) ends the statement but keeps the connection — allowed for one's own threads.
    killQuery(conn: mysql.PoolConnection) {
        const threadId = conn?.threadId;
        if (!this.pool || !threadId) return;
        this.pool.query("KILL QUERY " + Number(threadId)).catch(e =>
            logError("MysqlAdapter", `Can't kill timed-out query on thread ${threadId}: ${e?.message ?? e}`));
    }

    destroyConnection(conn: mysql.PoolConnection) {
        try {
            conn.removeAllListeners();
            conn.destroy();
        } catch (e) {
            logCrit("MysqlAdapter", `Can't destroy connection: ${e}`)
        }
    }

    finalizeConnection(conn: mysql.PoolConnection) {
        try {
            conn.removeAllListeners();
            conn.release();
        } catch (e) {
            logCrit("MysqlAdapter", `Can't release connection: ${e}`)
        }
    }

    // Placeholders are substituted in ONE pass over the template. Substituting field by field
    // re-scanned values already inserted, so a value containing "@otherField" (or a "$`"
    // replacement pattern) could break out of its quotes — SQL injection.
    prepareQuery(request: IDBQuery): string {

        const template = request.query;
        const fields = request.fields;
        const values = new Map<string, string>();
        const parsedFields: IDBQueryField[] = [];

        if (fields) {
            for (let i in fields) {
                const name = i;
                if (name.startsWith("$__"))
                    continue;

                const raw = fields[i];
                // Options (raw SQL included) only through dbField(). Any other value is escaped, objects
                // too (stored as JSON): request data shaped like { value, system: true } must not become SQL.
                if (!isDBField(raw) && looksLikeFieldOptions(raw))
                    throw new Error(`REQ_DB field "${name}": a plain { value, … } object is not read as field options — ` +
                        `use dbField(value, { … }); to store the object as JSON, pass JSON.stringify(it)`);
                const queryField: IDBQueryField = isDBField(raw)
                    ? { ...raw }
                    : raw === undefined || raw === null
                        ? { value: null, system: true }
                        : { value: raw as any, system: false };
                if (queryField.value === undefined || queryField.value === null) {
                    queryField.value = null;
                    queryField.system = true;
                }

                // add field name
                if (!queryField.name)
                    queryField.name = name.replaceAll("`", '').replaceAll('\"', "").replaceAll('\'', "")

                const parsed = MysqlAdapter.prepareQueryFieldValue(queryField);
                values.set(name, parsed + "");
                if (!queryField.name.startsWith("$__"))
                    parsedFields.push(queryField);
            }
        }

        // Column lists are built from field names, which may come from request data — always
        // quoted, so a name can't carry SQL.
        const column = (f: IDBQueryField) => MysqlAdapter.quoteIdentifier(f.name ?? "");
        const macro = (name: string, build: () => string) => {
            // A field with the same name wins, as before.
            if (!values.has(name) && template.indexOf("@" + name) !== -1)
                values.set(name, build());
        };

        macro("fields", () => parsedFields.filter(f => !f.ignoreInInsert).map(column).join(","));
        if (template.indexOf("@fields") !== -1)
            macro("values", () => parsedFields.filter(f => !f.ignoreInInsert).map(f => f.__parsedValue).join(","));
        macro("insert", () => {
            const list = parsedFields.filter(f => !f.ignoreInInsert);
            return `(${list.map(column).join(",")}) VALUES (${list.map(f => f.__parsedValue).join(",")})`;
        });
        macro("onupdate", () => parsedFields.filter(f => !f.ignoreInUpdate).map(f => column(f) + ' = ' + f.__parsedValue).join(" , "));
        macro("onduplicate", () => parsedFields.filter(f => f.useInReplace).map(f => column(f) + ' = ' + f.__parsedValue).join(" , "));

        let noLimit = false;
        if (!values.has("NOLIMIT") && template.indexOf("@NOLIMIT") !== -1) {
            values.set("NOLIMIT", "");
            noLimit = true;
        }

        let query = MysqlAdapter.substitute(template, values);

        const tmp = query.toLowerCase();
        if (tmp.indexOf("select") === 0 && !noLimit && tmp.indexOf("limit") === -1)
            query += " LIMIT 100"

        return query;
    }

    // Replaces every @name of `values` in a single pass: inserted text is never scanned again,
    // and the replacement is a function, so "$&", "$`" and the like in a value stay literal.
    static substitute(text: string, values: Map<string, string>): string {
        if (values.size === 0) return text;
        const names = [...values.keys()]
            .sort((a, b) => b.length - a.length)
            .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const regex = new RegExp("@(" + names.join("|") + ")(?=\\b|\\s|,|\\)|$)", "g");
        return text.replace(regex, (match, name) => values.get(name) ?? match);
    }

    static quoteIdentifier(name: string): string {
        return "`" + String(name).replaceAll("`", "") + "`";
    }

    static safeReplace(query:string, key:string, value:string):string{
        const name = key.startsWith("@") ? key.substring(1) : key;
        return MysqlAdapter.substitute(query, new Map([[name, value]]));
    }


    /** Prepare field value */
    static prepareQueryFieldValue(field: IDBQueryField): string | number | boolean | null | undefined {
        let value = field.value;
        let system = field.system;

        if (value === null || value === undefined){
            field.__parsedValue="NULL"
            return "NULL"
        }

        // add date in utc format — must run before the generic object→JSON branch below,
        // otherwise a Date is JSON.stringify'd into an ISO string instead of a MySQL DATETIME
        if (value instanceof Date) {
            const utcString = value.toISOString().slice(0, 19).replace('T', ' ');
            value = mysql.escape(utcString);
        }
        else {
            if (!system && typeof value === "object") {
                try {
                    value = JSON.stringify(value)
                } catch (e) {
                    logError("Can't prepare JSON object", e)
                    value = "{}"
                }
            }

            if (!system && typeof value === "string") {
                value = mysql.escape(value)
            }

            if (typeof value === "boolean")
                value = value ? 1 : 0;
        }

        // Nested fields fill a raw SQL fragment (system: true). An escaped value is already a quoted
        // literal: an escaped nested value put inside it would close the quotes.
        if(system && field.fields && typeof field.fields ==="object" && value && typeof value==="string" && value.indexOf("@")!==-1){
            // setup field in value — one pass, same reason as in prepareQuery
            const nested = new Map<string, string>();
            // Every key, 0 / "" / false / null included: skipping them left "@key" in the SQL.
            for(let key in field.fields)
                nested.set(key, mysql.escape(field.fields[key]));
            value = MysqlAdapter.substitute(value, nested);
        }

        field.__parsedValue = value;

        if(field.__parsedValue===null || field.__parsedValue===undefined){
            field.__parsedValue="NULL"
            value = field.__parsedValue
        }

        return value as any;
    }

  


    prepareCountQuery(query: string): string {
        // 1. Очищаем запрос от частей, которые не влияют на количество строк,
        // но замедляют выполнение или могут вызвать ошибки в подзапросе.
        let cleanQuery = query
            // Удаляем ORDER BY (игнорируем регистр 'i', работаем со всей строкой 's')
            .replace(/ORDER\s+BY\s+.*$/is, "")
            // Удаляем LIMIT и OFFSET
            .replace(/\bLIMIT\s+\d+(\s+OFFSET\s+\d+)?/is, "")
            .trim();

        // 2. Оборачиваем очищенный запрос в подзапрос.
        // Это универсальный способ: он корректно считает строки даже если есть GROUP BY.
        return `SELECT COUNT(1) AS \`count\` FROM (${cleanQuery}) AS \`temp_count_table\``;
    }


    // TRANSACTIONS
    async commit(trx: ITransaction): Promise<IDBError | null> {
        try {
            await trx.conn.commit();
            trx.conn.removeAllListeners();
            trx.conn.release();
            const trxIndex = this.transactions.indexOf(trx)
            this.transactions.splice(trxIndex,1)
        } catch (e) {
            const err = this.createMysqlQueryError(e);
            trx.queries.push({sql:"COMMIT",status:err.code})
            await this.rollbackTransaction(trx);
            return err;
        }
        return null;
    }


    async rollbackTransaction(trx: ITransaction, donNotRemove?: boolean): Promise<IDBError | null> {
        let err = null;
        if(!trx){
            logCrit("MysqlAdapter", "Can't rollback transaction, trx is null")
            return this.createMysqlQueryError(new Error("Transaction is null"));
        }
        try {
            logDB("Rollback started", trx.conn.threadId)
            await trx.conn.rollback();
            trx.conn.removeAllListeners();
            trx.conn.release();
            logDB("Rollback connection released", trx.conn.threadId)
            if (!donNotRemove && this.transactions)
                this.transactions = this.transactions.filter(i => trx && i && i.id !== trx.id);
            if (this.options.debug)
                logDB("Rollback complete", trx.conn.threadId)
            trx.queries.push({sql:"ROLLBACK",status:"ok"})
        } catch (e) {
            logCrit("MysqlAdapter", "Can't rollback transaction", trx.queries)
            err = this.createMysqlQueryError(e);
            trx.queries.push({sql:"ROLLBACK",status:"fail"})

            //remove transaction from list, because connection is broken
            try{
             trx.conn.destroy();
            }catch(e){logCrit("MysqlAdapter", "Can't destroy broken connection", e);}
            this.transactions = this.transactions.filter(i => i.id !== trx.id);
        }
        
        return err;
    }


    /**
     * Finish service
     * /
    async finish() {
        logInfo("Finishing mysql service")
        for (let i of this.transactions)
            await this.rollbackTransaction(i);

        if (this.pool) {
            try { await this.pool.end(); } catch (e) {
                logCrit("MysqlAdapter", "Can't close MYSQL pool!")
            }
        }

        if (this.failReportFileStream)
            this.failReportFileStream.end();
        this.failReportFileStream = null;
    }*/

    async finish() {
        logInfo("Finishing mysql service");

        for (const trx of [...this.transactions])
            await this.rollbackTransaction(trx);

        if (this.pool) {
            try {
                await this.pool.end();
            } catch (e) {
                logCrit("MysqlAdapter", "Can't close MYSQL pool!");
            }
        }

        if (this.failReportFileStream)
            this.failReportFileStream.end();

        this.failReportFileStream = null;
    }

    createMysqlQueryError(err: any, throwable?: boolean): IDBError {
        if (err && typeof err === "object" && "code" in err && "errno" in err && "sql" in err && "name" in err && "message" in err) {
            return {
                code: err.code,
                errno: err.errno,
                sql: err.sql,
                name: err.name,
                message: err.message,
                fatal: err.fatal && typeof err.fatal==="boolean"?err.fatal:false,
                isDuplicateError: err.code.toLowerCase().indexOf("dup_entry") !== -1
            }
        } else {
            return {
                code: "QUERY_ERR",
                errno: 100002,
                fatal: true,
                sql: "no query",
                name: "QUERY_ERR",
                message: "Error: " + (err instanceof Error ? err.message : String(err ?? "")),
                isDuplicateError: false
            }
        }
    }

    async storeTransactionAsProblem(trx: ITransaction, message: string) {

        if (!this.options.transactionFailReport && !this.options.transactionFailReportDir) {
            logCrit("MysqlAdapter", "Can't report failed transaction, no report function: transactionFailReport in options, and transactionFailReportDir isnt set")
            return;
        }

        if (this.options.transactionFailReportDir) {
            const yyymmdd = new Date().toISOString().substring(0, 10).replaceAll("-", "");

            //store transaction
            const date = new Date();
            const file = path.resolve(this.options.transactionFailReportDir, yyymmdd + ".json");

            // Date rolled over (or file path changed) — close the old stream
            if (this.failReportFileStream && this.failReportFileStreamName !== file) {
                try { this.failReportFileStream.end(); } catch {}
                this.failReportFileStream = null;
                this.failReportFileStreamName = null;
            }

            if (this.options.debug)
                logDB("Store transaction fail report: ", file, trx.queries, message)

            if (!this.failReportFileStream) {
                const stream = fs.createWriteStream(file, { flags: 'a' });
                // createWriteStream is lazy — open errors (EACCES, ENOENT, ...) arrive via the 'error'
                // event, NOT via the write() callback. Without a listener, Node treats it as uncaught
                // and kills the process. Attach the listener before the first write.
                stream.on('error', (err) => {
                    logCrit("MysqlAdapter", "Transaction fail report stream error: " + (err as Error).message);
                    if (this.failReportFileStream === stream) {
                        this.failReportFileStream = null;
                        this.failReportFileStreamName = null;
                    }
                });
                this.failReportFileStream = stream;
                this.failReportFileStreamName = file;
            }

            this.failReportFileStream.write(JSON.stringify({ queries: trx.queries, time: trx.timestamp, date, message }) + "\n}EOB{\n", err => {
                if (err)
                    logCrit("MysqlAdapter", "Can't write to transaction fail report file: " + err.message)
                else
                    logDB("MysqlAdapter", "Transaction fail report stored")
            });

            this.failReportLastAccessTime = Date.now();

        }


        if (this.options.transactionFailReport)
            this.options.transactionFailReport(trx, message);
    }


}

export function isError(obj: any): obj is IDBError {
    return obj && "code" in obj && "errno" in obj && "name" in obj && "message" in obj;
}
