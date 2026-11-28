import { Signal, Req } from "../signal/Signal";
import { BaseService } from "./BaseService";
import { Trace } from "./helper/Trace";

export enum LOG_LEVEL{
    ALL=10,
    API=19,
    INFO=20,
    DB = 25,
    WARN=30,
    ERROR=40,
    CRIT=50,
}
export interface ILogItem{
    id:number,
    level:LOG_LEVEL,
    time:number,
    text:string
    date:string
    source:string
    repeat:number // how many times this log was repeated
    traceId?:string // the request this was logged while handling (helper/Trace)
}

export interface ILogServiceOptions{
    output?:(data:ILogItem)=>void,
    stackSize:number
    level:LOG_LEVEL
    textLimit:number
    watchFor?:string[]
}

export const getDefaultLogOptions=():ILogServiceOptions=>{
    return {
        stackSize:100,
        textLimit:1024,
        level:LOG_LEVEL.ALL
    }
}

export const logInfo=(message:any,...optional:any[])=>{
    S_LOG.invoke({level:LOG_LEVEL.INFO,data:[message,optional],traceId:Trace.current() ?? undefined})
}
export const logWarn=(message:any,...optional:any[])=>{
    S_LOG.invoke({level:LOG_LEVEL.WARN,data:[message,optional],traceId:Trace.current() ?? undefined})
}
export const logCrit=(message:any,...optional:any[])=>{
    S_LOG.invoke({level:LOG_LEVEL.CRIT,data:[message,optional],traceId:Trace.current() ?? undefined})
}
export const logError=(message:any,...optional:any[])=>{
    S_LOG.invoke({level:LOG_LEVEL.ERROR,data:[message,optional],traceId:Trace.current() ?? undefined})
}
export const logDB = (message:any,...optional:any[])=>{
    S_LOG.invoke({level:LOG_LEVEL.DB,data:[message,optional],traceId:Trace.current() ?? undefined})
}
export const logAPI = (message:any,...optional:any[])=>{
    S_LOG.invoke({level:LOG_LEVEL.API,data:[message,optional],traceId:Trace.current() ?? undefined})
}


// syslog priority of each level, for the systemd journal.
const JOURNAL_PRIORITY: Record<number, number> = {
    [LOG_LEVEL.ALL]: 7, [LOG_LEVEL.API]: 6, [LOG_LEVEL.INFO]: 6, [LOG_LEVEL.DB]: 6,
    [LOG_LEVEL.WARN]: 4, [LOG_LEVEL.ERROR]: 3, [LOG_LEVEL.CRIT]: 2,
};

/**
 * One log item as a line for stdout: "2026-11-27 10:00:00 WARN text". When stdout goes to the systemd
 * journal (systemd sets JOURNAL_STREAM), the line starts with the level for journald ("<4>"), so
 * `journalctl -p warning` and `bmfk ps log --errors` find warnings and errors.
 *   logOptions.output = item => console.log(logLine(item));
 */
export function logLine(item: ILogItem, env: NodeJS.ProcessEnv = process.env): string {
    const prefix = env.JOURNAL_STREAM ? `<${JOURNAL_PRIORITY[item.level] ?? 6}>` : "";
    return `${prefix}${item.date} ${LOG_LEVEL[item.level] ?? item.level} ${item.text}`;
}

export const S_LOG=new Signal<{level:LOG_LEVEL,data:any[],traceId?:string}>()
export const S_LOG_CREATED=new Signal<ILogItem>()
export const S_LOG_CHANGE_LEVEL=new Signal<LOG_LEVEL>();
export const REQ_CURRENT_LOG_LEVEL=new Req<void,LOG_LEVEL>(undefined,"REQ_CURRENT_LOG_LEVEL")
export const S_LOG_FLUSH=new Signal<void>();
export const S_LOG_ADD_SERVICE_TO_WATCH=new Signal<string>();
export const S_LOG_REMOVE_SERVICE_FROM_WATCH=new Signal<string>();
export const S_LOG_SET_TEXT_LIMIT=new Signal<number>();
export const REQ_LOG=new Req<{lastID:number}|null|undefined,ILogItem[]>();
export const REQ_LOG_UNIQUE_SERVICES=new Req<void,{name:string,count:number}[]>();

export class LogService extends BaseService{

    static nextID=0;
    log:ILogItem[]=[];
    options:ILogServiceOptions
    level:LOG_LEVEL=LOG_LEVEL.ALL
    
    uniqueServices:Map<string,number>=new Map() // service name (name.js) & count of log requests

    constructor(opt?:ILogServiceOptions){
        super("LogService");
        if(!opt)
            opt=getDefaultLogOptions();
        this.options=opt;
        this.level = opt.level
        this.checkTextLimit();
    }

    async init(){
        
      

        REQ_LOG_UNIQUE_SERVICES.listener = async ()=>{
            const arr=[];
            for(let i of this.uniqueServices)
                arr.push({name:i[0],count:i[1]})
            return arr;
        }

        REQ_LOG.listener = async (req) => {
            if(req && req.lastID){  
                let result=this.log.filter(val=>val.id>req.lastID)
                return result
            }else
                return [...this.log]
        }

        S_LOG_SET_TEXT_LIMIT.subscribe(l=>{
            this.options.textLimit=l;
            this.checkTextLimit();
        })
        
        S_LOG_ADD_SERVICE_TO_WATCH.subscribe(service=>{
            if(!this.options.watchFor)
                this.options.watchFor=[];

            if(this.options.watchFor.find(val=>val===service)){
                logCrit("${LogService.js}","Service \""+service+"\" aleready added");
                return;
            }
            this.options.watchFor.push(service);
        })

        S_LOG_REMOVE_SERVICE_FROM_WATCH.subscribe(service=>{
            if(!this.options.watchFor)
                return;

            try{
            const i = this.options.watchFor.findIndex(val=>val===service)
            if(i>-1)
                this.options.watchFor.splice(i,1);
            }catch(e){
                logCrit("${LogService.js}","Service \""+service+"\" not deleted");
            }
        })

        S_LOG_CHANGE_LEVEL.subscribe(l=>{this.level=l})

        REQ_CURRENT_LOG_LEVEL.listener = async ()=>this.level

        S_LOG_FLUSH.subscribe(()=>this.log=[])

        S_LOG.subscribe((log)=>{

            if(log.level<this.level)
                return;

            const msg=log.data[0];
            const optional=log.data[1];
            let text = this.createText(msg,log.level);
            let source="";
            if(text.startsWith("${") && text.endsWith("}") && text.indexOf(".js")!==-1){
                source=text.substring(2,text.length-1);
                text = ""
            }

            const usc=this.uniqueServices.get(source) ?? 0;
            this.uniqueServices.set(source,usc+1)

            let showlog=true;
            if(this.options && this.options.watchFor && Array.isArray(this.options.watchFor) && this.options.watchFor.length>0){
                showlog=false;
                for(let i of this.options.watchFor){
                    if(source.toLowerCase().indexOf(i.toLowerCase())!==-1){
                        showlog=true;
                        break;
                    }
                }
            }

            if(!showlog && this.level===LOG_LEVEL.CRIT)
                showlog=true;

            if(optional){
                for(let i of optional)
                    text+=", "+this.createText(i,this.level);
            }



            const d = new Date();
            const logitem:ILogItem={
                level:log.level,
                id:LogService.nextID++,
                text:text,
                time:d.getTime(),
                date:this.createDate(d),
                source:source,
                repeat:0,
                traceId:log.traceId
            }

            // output as string
            if(this.options.output){    
                this.options.output(logitem);
            }

            if(this.log.length>0){
                // check if this log item is already in stack
                const lastLogItem = this.log[this.log.length-1];
                if(lastLogItem && lastLogItem.text === logitem.text && lastLogItem.source === logitem.source && lastLogItem.level === logitem.level && lastLogItem.traceId === logitem.traceId){
                    // increase repeat count
                    lastLogItem.repeat++;
                    lastLogItem.time = logitem.time; // update time
                    lastLogItem.date = logitem.date; // update date
                    LogService.nextID--; // do not increase ID
                    S_LOG_CREATED.invoke(lastLogItem)
                    return; // do not add to stack
                }
            }


            // fire log item
            S_LOG_CREATED.invoke(logitem)

            // add log item to stack
            this.log.push(logitem);
            let limit = this.options.stackSize ?? 100
            if(limit>1000)
                limit = 1000
            if(this.log.length>limit)
                this.log.shift();

        })

        super.init();
    }

    checkTextLimit(){
        if(this.options.textLimit>1024*4)
            this.options.textLimit=1024*4
    }

    createDate(d?:Date):string{
        if(!d)
            d=new Date();
        return d.getFullYear()+"-"+this.leadZero(d.getMonth()+1)+"-"+this.leadZero(d.getDate())+" "+this.leadZero(d.getHours())+":"+this.leadZero(d.getMinutes())+":"+this.leadZero(d.getSeconds());
    }

    leadZero(num:number):string{
        if(num<10)
            return "0"+num;
        return num+""
    }

    createText(data:any,level:LOG_LEVEL){

        if(data === null)
            return "null"

        if(data === undefined)
            return "undefined"

        let res=""

        if(data instanceof Error){
            res = data.stack ?? `${data.name}: ${data.message}`
        }else if(typeof data ==="object"){

            try{
                const tmp =JSON.stringify(data,null,"\t")
                res = tmp ?? "";
            }catch(e){
                if("toString" in data && data.toString && typeof data.toString === "function")
                    res = data.toString()
            }


            if(`${data}`==="[object Map]" && "size" in data){
                // try to parse map!
                try{
                    const arr=[];
                    for(let i of data)
                        arr.push({key:i[0],value:i[1]})
                    res = "MAP (size:"+data.size+") \n"+JSON.stringify(arr,null,"\t");
                }catch(e){}
            }

            if(Array.isArray(data))
                res+", total items: "+data.length

        }else{
            res=data+""
        }

        // Redact PANs, PCI SAD, credentials, and other high-risk fragments BEFORE shortening: a cut
        // through a value would leave half of it readable (the rules need the whole value).
        res = LogService.sanitize(res);

        if(res.length>this.options.textLimit && level===LOG_LEVEL.INFO)
            res=res.substring(0,this.options.textLimit)+"... (total: "+res.length+")"

        return res
    }

    // ---- sanitization ----
    // Order matters: content-based rules (PEM/JWT/Bearer/Track) run first — they have
    // near-zero false-positive rate. Structured (JSON-style key:value) rules run next.
    // PAN masking with Luhn check is applied at the end (from within sanitize()).
    private static readonly SANITIZERS: ReadonlyArray<readonly [RegExp, string]> = [
        // PEM blocks — RSA/EC/DSA private keys, certificates, openssh keys.
        [/-----BEGIN [A-Z0-9 ]+-----[\s\S]+?-----END [A-Z0-9 ]+-----/g, "<REDACTED PEM>"],

        // JWT — three base64url segments separated by dots, first two start with "eyJ".
        [/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, "<REDACTED JWT>"],

        // Authorization schemes — Bearer / Basic / Digest tokens.
        [/(Bearer|Basic|Digest)\s+[A-Za-z0-9\-._~+\/=]+/gi, "$1 <REDACTED>"],

        // Credentials inside connection strings: mysql://user:secret@host, postgres://…, amqp://…
        // Database clients and migration tools print these verbatim on connection errors.
        [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]+@/gi, "$1<REDACTED>@"],

        // Magstripe track 1 / track 2 data — highly distinctive framing.
        [/%B\d{13,19}\^[^?]{2,50}\^\d{4,}[^?]*\?/g, "<REDACTED TRACK1>"],
        [/;\d{13,19}=\d{4,}[^?]*\?/g, "<REDACTED TRACK2>"],

        // JSON-style "sensitive-key": "value" — covers PCI SAD (CVV/CVC/PIN), CHD (exp,
        // holder name), credentials (password/secret/apikey/token), sessions and auth headers.
        [/("(?:password|passwd|pwd|secret|api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie|set[_-]?cookie|session[_-]?id|sess[_-]?id|sid|cvv2?|cvc2?|cvn|cav2?|cid|security[_-]?code|card[_-]?verification[_-]?(?:value|code)?|pin|pin[_-]?block|encrypted[_-]?pin|iso[_-]?9564|exp|expiry|expiration|expiration[_-]?date|exp[_-]?date|exp[_-]?month|exp[_-]?year|cardholder[_-]?name|holder[_-]?name|card[_-]?holder|pan|dpan|primary[_-]?account[_-]?number|application[_-]?primary[_-]?account[_-]?number|card[_-]?number|card[_-]?no|account[_-]?number|application[_-]?expiration[_-]?date|online[_-]?payment[_-]?cryptogram|cryptogram|emv[_-]?data|track[12]?[_-]?data)"\s*:\s*)"[^"]*"/gi, '$1"<REDACTED>"'],

        // Same-key JSON but with unquoted numeric values (CVV/PIN/expMonth often come as numbers).
        [/("(?:cvv2?|cvc2?|pin|exp[_-]?month|exp[_-]?year|service[_-]?code|pan|dpan|primary[_-]?account[_-]?number|application[_-]?primary[_-]?account[_-]?number|card[_-]?number|account[_-]?number)"\s*:\s*)(-?\d+)/gi, '$1"<REDACTED>"'],

        // Query-string / form-encoded secrets: ?token=…&password=… — the shape credentials take
        // in URLs (outgoing request logs, nginx access logs, redirect targets).
        [/([?&;](?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|auth|authorization|session|session[_-]?id|sid|cvv2?|cvc2?|pin|pan|signature|sig)=)[^&\s"'<>;]*/gi, "$1<REDACTED>"],
    ];

    // Property/header NAMES whose value must never be shown, whatever its shape. Used by
    // sanitizeDeep for objects (headers, params, interceptor results), where the regex rules
    // above — which look for "key":"value" in serialized text — don't apply.
    private static readonly SENSITIVE_KEY_RE = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|apikey|password|passwd|pwd|secret|client[_-]?secret|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session[_-]?id|sess[_-]?id|sid|cvv2?|cvc2?|cvn|cav2?|security[_-]?code|card[_-]?verification[_-]?(?:value|code)?|pin|pin[_-]?block|pan|card[_-]?number|exp|expiry|expiration|exp[_-]?date|exp[_-]?month|exp[_-]?year|cardholder[_-]?name|holder[_-]?name|card[_-]?holder|pan|dpan|primary[_-]?account[_-]?number|application[_-]?primary[_-]?account[_-]?number|card[_-]?number|card[_-]?no|account[_-]?number|application[_-]?expiration[_-]?date|online[_-]?payment[_-]?cryptogram|cryptogram|emv[_-]?data|track[12]?[_-]?data)$/i;

    static sanitize(text: string): string {
        if (!text || text.length < 3) return text;
        let out = text;
        for (const [re, repl] of LogService.SANITIZERS)
            out = out.replace(re, repl);
        // PAN mask last — Luhn-checked. Runs after key-based redaction so numeric fields
        // like "cvv":123 have already been cleaned and can't accidentally Luhn-validate.
        return LogService.maskPAN(out);
    }

    // Any 13-19 digit run with optional single spaces or dashes as separators.
    // Lookarounds ensure we don't cut inside a longer digit string.
    private static readonly PAN_CANDIDATE_REGEX = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

    // Luhn check filters random digit strings (order IDs, timestamps, etc.) —
    // only real card-number-shaped values pass. Guards against noisy false positives.
    private static isLuhnValid(digits: string): boolean {
        if (digits.length < 13 || digits.length > 19) return false;
        let sum = 0;
        let alt = false;
        for (let i = digits.length - 1; i >= 0; i--) {
            const d = digits.charCodeAt(i) - 48;
            if (d < 0 || d > 9) return false;
            let x = d;
            if (alt) {
                x *= 2;
                if (x > 9) x -= 9;
            }
            sum += x;
            alt = !alt;
        }
        return sum % 10 === 0;
    }

    /**
     * Sanitize a value of ANY shape for display, returning a NEW structure — the input is never
     * mutated. Use it for things that are logged/returned as objects (HTTP headers, route params,
     * interceptor results): sanitize() alone only works on already-serialized text, and redacting
     * such an object in place would corrupt the live request the app is still serving.
     *
     * Strings are sanitized, values under sensitive KEY names are dropped entirely, shape is kept
     * so UIs keep working. Depth-capped, which also stops cycles.
     */
    /**
     * A value as it may be stored in a journal: redacted FIRST, then shortened (strings to `maxString`,
     * the whole text to `maxTotal`). In that order a cut can't leave half a password or half a card
     * number readable — the rules that find them need the whole value.
     */
    static snapshot(value: any, maxString = 255, maxTotal = 500): string {
        if (value === undefined || value === null) return value;
        let json: string | undefined;
        try {
            json = JSON.stringify(LogService.sanitizeDeep(value), (_k, v) =>
                typeof v === "string" && v.length > maxString ? v.slice(0, maxString) + `...(${v.length})` : v);
        } catch {
            return "[unserializable data]";
        }
        if (typeof json !== "string") return "";
        json = LogService.sanitize(json);
        return json.length > maxTotal ? json.slice(0, maxTotal) + `...(total ${json.length})` : json;
    }

    static sanitizeDeep(value: any, depth = 0): any {
        if (depth > 8) return "<DEPTH LIMIT>";
        if (value === null || value === undefined) return value;

        const t = typeof value;
        if (t === "string") return LogService.sanitize(value);
        if (t === "number" || t === "boolean") return value;
        if (t === "function" || t === "symbol") return `[${t}]`;
        if (t === "bigint") return value.toString();
        if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
        if (value instanceof Date) return value.toISOString();

        if (Array.isArray(value)) {
            const capped = value.length > 200 ? value.slice(0, 200) : value;
            const out = capped.map(v => LogService.sanitizeDeep(v, depth + 1));
            if (value.length > capped.length) out.push(`…(${value.length} items total)`);
            return out;
        }

        if (t === "object") {
            const out: Record<string, any> = {};
            let n = 0;
            for (const k of Object.keys(value)) {
                if (++n > 200) { out["…"] = `(${Object.keys(value).length} keys total)`; break; }
                out[k] = LogService.SENSITIVE_KEY_RE.test(k)
                    ? "<REDACTED>"
                    : LogService.sanitizeDeep(value[k], depth + 1);
            }
            return out;
        }
        return String(value);
    }

    // Card-brand IINs. A number can fail Luhn and still clearly be a card (a typo, a test PAN, a
    // partially transcribed one) — in a log that is exactly "looks like a PAN", so we mask it.
    // Catching a stray order id is cheap; leaking cardholder data is not.
    private static readonly CARD_IIN_RE = /^(?:4|5[1-5]|2[2-7]|3[47]|35|6011|64[4-9]|65|62|3(?:0[0-5]|[68]))/;

    // Set to false to mask ONLY Luhn-valid numbers (fewer false positives, weaker protection).
    private static readonly AGGRESSIVE_PAN_MASKING = true;

    private static looksLikePAN(digits: string): boolean {
        if (digits.length < 13 || digits.length > 19) return false;
        if (LogService.isLuhnValid(digits)) return true;
        return LogService.AGGRESSIVE_PAN_MASKING && LogService.CARD_IIN_RE.test(digits);
    }

    static maskPAN(text: string): string {
        if (!text || text.length < 13) return text;
        return text.replace(LogService.PAN_CANDIDATE_REGEX, (match) => {
            const digits = match.replace(/\D/g, "");
            if (!LogService.looksLikePAN(digits)) return match;
            // Keep the last 4 — PCI-DSS allows it and it is what makes a log usable for support.
            return "xxxx...xxxx" + digits.slice(-4);
        });
    }
}