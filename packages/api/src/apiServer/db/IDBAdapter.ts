import { IDBBulkQuery, IDBQuery, IDBResult, IDBStatFrame, IPoolStatus } from "../DBService"




export interface IDBAdapter{
    init():Promise<void>
    finish():Promise<void>
    tBegin?():Promise<IDBResult>
    tCommit?(trxid:number):Promise<IDBResult>
    tRollback?(trxid:number):Promise<IDBResult>
    prepareQuery(request:IDBQuery):string
    query(request:IDBQuery):Promise<IDBResult>
    bulk(request:IDBBulkQuery):Promise<IDBResult[]>
    poolStatus():IPoolStatus
    escape(value:string):string
    stat():Map<number,IDBStatFrame> // key is yyyymmddhhmm, value is stat frame for this minute
}