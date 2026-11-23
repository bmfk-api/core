import os from "os";
import { logWarn } from "../LogService";
import { Http } from "../http/Http";

export interface ITelegramOptions {
    bot: string;      // bot token from @BotFather
    chat: string;     // chat id: a group ("-100…") or a user
    topic?: number;   // message_thread_id, for a topic in a forum group
    api?: string;     // tests only: another address instead of https://api.telegram.org
}

const esc = (v: string) => String(v).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** One line per deployer event, e.g. "✅ shop — done by ci". Failed or ok, every status gets an icon. */
export function telegramText(project: string, status: string, user: string, host = os.hostname()): string {
    const icon = /error|fail|declined/.test(status) ? "❌" : /review/.test(status) ? "👀" : /roll|restor|switch/.test(status) ? "🔄" : "✅";
    return `${icon} <b>${esc(project)}</b> — ${esc(status)}\nby <b>${esc(user)}</b> · ${esc(host)} · ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Sends a message to Telegram. The token is part of the URL, so the call is made with skipLogging: it
 * never reaches the outgoing journal or the per-URL stats. Never throws; a failure is logged without the token.
 */
export async function sendTelegram(opt: ITelegramOptions, text: string): Promise<boolean> {
    const resp = await Http.post(`${opt.api ?? "https://api.telegram.org"}/bot${opt.bot}/sendMessage`,
        { chat_id: opt.chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(opt.topic ? { message_thread_id: opt.topic } : {}) },
        { skipLogging: true, timeoutMs: 10_000, retry: { enabled: false } });
    if (resp.ok) return true;
    const description = (resp as any).error?.description;
    logWarn(`Telegram: message to chat ${opt.chat} not sent — ${resp.status ? `HTTP ${resp.status}` : "network error"}${description ? ": " + description : ""}`);
    return false;
}
