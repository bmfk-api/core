import crypto from "crypto"
export class UID{
    private static readonly epoch = 1697037922668;
    private static nextUniqueID=1;
    private static nextUniqueTRXID=1;
    static generate():string{
        let uid = Buffer.from(
         parseInt(
            ((+new Date())-this.epoch)
            +""
            +Math.round(Math.random()*1000)
        ).toString(16),'hex').toString('base64');

        uid=uid.replaceAll("=","")
        uid=uid.replaceAll("+","pL")
        uid=uid.replaceAll("/","sl")
        
        return uid;
    }

    static generateRandomNumberBase(count:number):string{
        let base="";
        for(let i=0;i<count;i++)
            base+=Math.round(Math.random()*9);
        return base;
    }


    static generateNumeric(year?:string):bigint{
        if (!year)
            year = new Date().getFullYear().toString();
    

        const yearSuffix = year.substring(2); // последние 2 цифры года
        const now = BigInt(Date.now());
        const delta = now - BigInt(UID.epoch);

        const counter = UID.nextUniqueID++;
        if (UID.nextUniqueID > 99) {
            UID.nextUniqueID = 1;
        }

        const counterStr = counter.toString().padStart(2, '0');

        // Склеиваем строки, затем превращаем в BigInt
        const idStr = `${yearSuffix}${delta.toString()}${counterStr}`;
        return BigInt(idStr);
    }

    static getDateFromNumeric(uid:number|bigint):Date{
        const uidStr = uid.toString();
        const yearSuffix = uidStr.substring(0, 2); // '25' → не используем дальше
        const counterDigits = 2;
        const deltaStr = uidStr.substring(2, uidStr.length - counterDigits);
        const delta = BigInt(deltaStr);
        const timestamp = BigInt(UID.epoch) + delta;
        return new Date(Number(timestamp));
    }

    static generateNumberic(year?:string):number{
        if(!year)
            year = new Date().getFullYear()+"";
        const nextID=UID.nextUniqueID++;
        if(UID.nextUniqueID>99)
            UID.nextUniqueID = 1
        return parseInt(year.substring(2)+""+(+new Date() - this.epoch)+""+(nextID+"").padStart(2,"0"));
    }

    static getNextDescendingIndex():number{
        return Number.MAX_SAFE_INTEGER - (+new Date());
    }

    static getNext():string{
        const nextID=UID.nextUniqueID++;
        if(UID.nextUniqueID>99)
            UID.nextUniqueID = 1
        return this.leadZero(nextID)
    }
    
    static getNextTRX():string{
        const nextID=UID.nextUniqueTRXID++;
        if(UID.nextUniqueTRXID>99)
            UID.nextUniqueTRXID = 1
        return this.leadZero(nextID)
    }

  

    static generateTrxUID(date?:Date){
        
        if(!date)
            date=new Date();

        const year = (new Date().getFullYear()+"").substring(2);
        const seconds = (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds())+"";

        const str=year
            +this.leadZero(date.getMonth()+1)
            +this.leadZero(date.getDate())
            +seconds.padStart(5,"0")
            +this.getNextTRX()

        return parseInt(str);
            
    }


    static sha256(str:string,nochanges?:boolean):string{
        
        if(nochanges)
            return crypto.createHash("sha256").update(str).digest("hex");

        let uid = crypto.createHash("sha256").update(str).digest("base64");
        uid=uid.replaceAll("=","")
        uid=uid.replaceAll("+",".")
        uid=uid.replaceAll("/","-")
        return uid;
    }

    static leadZero(i:number):string{
        return (i+"").padStart(2,"0")
    }
}