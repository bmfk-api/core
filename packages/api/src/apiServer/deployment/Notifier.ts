import { logError } from "../LogService";
import { createHash } from 'crypto';
import { Req } from "../../signal/Signal";
import { BaseService } from '../BaseService';
import { Http } from "../http/Http";

export interface IDeploymentNotifier extends BaseService{
    // `user` — login of the deployer user who triggered the action, or a system marker
    // like "watchdog" for automated events (readiness checks etc.).
    notifyEmailStatus(email:string,status:string,project:string,user:string):Promise<void>;
    notifySMSStatus(phone:string,text:string,user:string):Promise<void>;
    // Review request with the reviewer's personal link. Resolves false when the mail service didn't take it.
    notifyReview(email:string,info:{project:string,user:string,link:string,expiresAt:number,mode:"any"|"all"}):Promise<boolean>;
}


export class Notifier  extends BaseService implements IDeploymentNotifier {

    SMS_URL:string;
    SMS_KEY:string;


    constructor({URL,KEY}:{URL:string,KEY:string}){
        super("Notifier");
        this.SMS_URL = URL;
        this.SMS_KEY = KEY;
    }


    async init() {
        super.init();
    }
    
    async notifyEmailStatus(email: string, status: string, project: string, user: string): Promise<void> {
        const text = `${project} deployment <b>${status}</b> by <b>${user}</b> ${new Date().toISOString()}`;
        const title = `Deployment: ${project} - ${status} (${user})`;

        const token = createHash("sha256").update(this.SMS_KEY+email+title+text).digest("base64")

        let response=null;
        try{
            response = await Http.post(this.SMS_URL+"/api/mail/send",{
                to:email,
                text:title,
                html:text
            },{
                headers:{
                    "authorization":token,
                    "Content-Type":"application/json"
                }
            })
        }catch(e){
            logError(e);
        }
    }

    async notifyReview(email: string, info: { project: string, user: string, link: string, expiresAt: number, mode: "any" | "all" }): Promise<boolean> {
        const esc = (v: string) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
        const title = `Deploy review: ${info.project} (uploaded by ${info.user})`;
        const text = `<p><b>${esc(info.user)}</b> uploaded a new version of <b>${esc(info.project)}</b>. It is not deployed until it is reviewed`
            + (info.mode === "all" ? " by every reviewer" : "") + `.</p>`
            + `<p><a href="${esc(info.link)}">Review the changes</a> — sign in with your reviewer login, password and 2FA code.</p>`
            + `<p>The link is personal and valid until ${esc(new Date(info.expiresAt).toISOString())}, or until a newer upload replaces it. `
            + `Don't forward it. If you didn't expect this, decline and tell the team.</p>`;
        const token = createHash("sha256").update(this.SMS_KEY+email+title+text).digest("base64")
        try{
            const response = await Http.post(this.SMS_URL+"/api/mail/send",{ to:email, text:title, html:text },{
                headers:{ "authorization":token, "Content-Type":"application/json" }
            });
            if(!response.ok) logError(`Review mail to ${email} failed: HTTP ${response.status ?? "network error"}`);
            return response.ok;
        }catch(e){
            logError(e);
            return false;
        }
    }

    async notifySMSStatus(phone: string, text: string, user: string): Promise<void> {
        const finalText = `${text} (by ${user})`;
        const token = createHash("sha256").update(this.SMS_KEY+phone+finalText+"").digest("base64")
        let response=null;
        try{
            response = await Http.post(this.SMS_URL+"/api/sms",{
                to:phone,
                content:finalText
            },{
                headers:{
                    "authorization":token,
                    "Content-Type":"application/json"
                }
            })
        }catch(e){
            logError(e);
        }
    }



}