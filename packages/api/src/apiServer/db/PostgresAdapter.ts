import { Pool, PoolClient } from 'pg';
import { DBAdapterOptions, IDBQuery, IDBResult, IDBBulkQuery, IPoolStatus, IDBStatFrame } from '../DBService';
import { IDBAdapter } from './IDBAdapter';
import { logError } from '../LogService';


export class PostgresAdapter implements IDBAdapter{

    options: DBAdapterOptions;
    serviceStarted: boolean = false;

    reconnectionTimeout = 1000 * 3;
    reconnecting = false;
    pool:Pool|null=null;
    timeoutID: any

    queries = []; // TODO: STORE QUERIES SENTS BEFORE THE SERVICE IS STARTED!


    static nextTransactionID = 1;
    transactions: { id: number, timestamp: number, conn: PoolClient, queries: { sql: string, status: string }[] }[] = []
    maxTransactionWaitTime = 1000 * 60 * 2; // 2 min and detelete transaction

    lastSuccessQueryTime = 0;
    pingInterval = 1000 * 60 * 5; // each 5 min

    poolConnections: number = 0;
    acquiredPoolConnections: number = 0;

    statFrames: Map<number, IDBStatFrame> = new Map();

    constructor(options: DBAdapterOptions) {
        this.options = options;
    }

    stat(){
        return this.statFrames
    }

    escape(value: string): string {
        return value;
    }
    tBegin?(): Promise<IDBResult> {
        throw new Error('Method not implemented.');
    }
    tCommit?(trxid: number): Promise<IDBResult> {
        throw new Error('Method not implemented.');
    }
    tRollback?(trxid: number): Promise<IDBResult> {
        throw new Error('Method not implemented.');
    }
    poolStatus(): IPoolStatus {
        throw new Error('Method not implemented.');
    }

    async init(){
        // Create a new pool with the provided connection string and options
        this.pool = new Pool({
            connectionString:"postgresql://" + this.options.user + ":" + this.options.password + "@" + this.options.host + ":" + this.options.port + "/" + this.options.database+(this.options.connectionParamers ?? ""),
            max:this.options.connectionLimit || 10,
            idleTimeoutMillis: this.options.idleTimeoutMillis || 1000 * 60 * 5, // 5 min
            connectionTimeoutMillis: this.options.connectionTimeoutMillis || 1000 * 10, // 10 sec
            keepAlive: true,
        })
    }

    async healthcheck(): Promise<boolean> {
        
        if(!this.pool){
            logError("PostgreAdapter: Pool is not initialized.");
            return false;
        }

        const { rows } = await this.pool.query('SELECT 1 AS ok');
        return rows?.[0]?.ok === 1;
    }


    finish(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    prepareQuery(request: IDBQuery): string {
        throw new Error("Method not implemented.");
    }
    query(request: IDBQuery): Promise<IDBResult> {
        throw new Error("Method not implemented.");
    }
    bulk(request: IDBBulkQuery): Promise<IDBResult[]> {
        throw new Error("Method not implemented.");
    }
}