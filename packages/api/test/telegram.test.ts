import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { sendTelegram, telegramText } from "../src/apiServer/deployment/TelegramNotifier";
import { validateConfig } from "../src/apiServer/deployment/resolveConfig";
import { S_LOG } from "../src/apiServer/LogService";
import { Http } from "../src/apiServer/http/Http";
import { exitWhenDone } from "./helpers";

exitWhenDone();

test("the message: icon by status, project and user escaped", () => {
    assert.match(telegramText("shop", "done", "ci", "srv1"), /^✅ <b>shop<\/b> — done\nby <b>ci<\/b> · srv1 · /);
    assert.match(telegramText("shop", "error-pm2", "ci"), /^❌/);
    assert.match(telegramText("shop", "rolled-back-to-blue", "ci"), /^🔄/);
    assert.match(telegramText("shop", "waiting for review (ann)", "ci"), /^👀/);
    assert.ok(telegramText("<x>", "done", "a&b").includes("&lt;x&gt;") && telegramText("<x>", "done", "a&b").includes("a&amp;b"));
});

test("sends to the bot API; a refusal is logged without the token", async () => {
    const got: any[] = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            got.push({ url: req.url, body: JSON.parse(body) });
            const ok = got.length === 1;
            res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify(ok ? { ok: true } : { ok: false, description: "Bad Request: chat not found" }));
        });
    });
    await new Promise<void>(r => server.listen(18814, r));
    const logs: string[] = [];
    const id = S_LOG.subscribe(l => logs.push(String(l.data[0])));
    try {
        const opt = { bot: "123:SECRET", chat: "-100777", topic: 5, api: "http://127.0.0.1:18814" };
        assert.equal(await sendTelegram(opt, "hello"), true);
        assert.equal(got[0].url, "/bot123:SECRET/sendMessage");
        assert.deepEqual({ ...got[0].body }, { chat_id: "-100777", text: "hello", parse_mode: "HTML", disable_web_page_preview: true, message_thread_id: 5 });
        assert.equal(await sendTelegram(opt, "again"), false);
        assert.ok(logs.some(l => l.includes("chat not found")));
        assert.ok(!logs.some(l => l.includes("SECRET")));
        // skipLogging: nothing with the token in the outgoing journal; the host still counts
        assert.ok(!JSON.stringify(Http.getOutgoingLogSnapshot()).includes("SECRET"));
        assert.ok(!JSON.stringify(Http.getHttpStats()).includes("SECRET"));
        assert.ok(JSON.stringify(Http.getHttpStats()).includes("127.0.0.1"));
        const recorded = Http.getOutgoingLogSnapshot().filter(e => e.skipLogging);
        assert.equal(recorded.length, 2);                                   // the calls are there, marked
        assert.equal(recorded[0].url, "http://127.0.0.1:18814");           // only the origin
        assert.equal(recorded[0].request, "[not logged]");
        assert.equal(recorded[1].status, 400);
    } finally {
        S_LOG.unsubscribe(id);
        server.close();
    }
});

test("versionBump must be a boolean", () => {
    const base = { name: "x", host: "https://d/api/pckg/add", token: "t", username: "u", password: "p" };
    assert.equal(validateConfig({ ...base, versionBump: false }), null);
    assert.match(String(validateConfig({ ...base, versionBump: "no" })), /versionBump/);
});
