import { test } from "node:test";
import assert from "node:assert/strict";
import { Signal, Req } from "../src/signal/Signal";

test("subscribers run in the order they subscribed", () => {
    const s = new Signal<number>("order");
    const seen: string[] = [];
    s.subscribe(n => seen.push("a" + n));
    s.subscribe(n => seen.push("b" + n));
    s.invoke(1);
    assert.deepEqual(seen, ["a1", "b1"]);
});

test("a throwing subscriber does not stop the others or break the signal", () => {
    const s = new Signal<number>("throws");
    const errors: unknown[] = [];
    const saved = Signal.onError;
    Signal.onError = (_s, e) => errors.push(e);
    try {
        const seen: number[] = [];
        s.subscribe(() => { throw new Error("boom"); });
        s.subscribe(n => seen.push(n));
        s.invoke(1);
        s.invoke(2);                                    // the old library stayed "busy" forever here
        assert.deepEqual(seen, [1, 2]);
        assert.equal(errors.length, 2);
    } finally {
        Signal.onError = saved;
    }
});

test("an invoke from inside a subscriber runs after the current one, in order", () => {
    const s = new Signal<number>("reentrant");
    const seen: string[] = [];
    s.subscribe(n => { seen.push("a" + n); if (n === 1) { s.invoke(2); s.invoke(3); } });
    s.subscribe(n => seen.push("b" + n));
    s.invoke(1);
    assert.deepEqual(seen, ["a1", "b1", "a2", "b2", "a3", "b3"]);
});

test("subscribing or unsubscribing while running applies from the next invoke", () => {
    const s = new Signal<number>("changes");
    const seen: string[] = [];
    let lateId = "";
    const removeMe = s.subscribe(n => seen.push("removed" + n));
    s.subscribe(n => {
        seen.push("main" + n);
        if (n === 1) {
            lateId = s.subscribe(m => seen.push("late" + m));
            s.unsubscribe(removeMe);
        }
    });
    s.invoke(1);
    s.invoke(2);
    assert.deepEqual(seen, ["removed1", "main1", "main2", "late2"]);
    assert.equal(s.unsubscribe(lateId), true);
});

test("unsubscribe reports whether something was removed; the same callback keeps one id", () => {
    const s = new Signal<void>("ids");
    const cb = () => {};
    const id = s.subscribe(cb);
    assert.equal(s.subscribe(cb), id);
    assert.equal(s.size, 1);
    assert.equal(s.subscribe(() => {}, "named"), "named");
    assert.equal(s.unsubscribe(id), true);
    assert.equal(s.unsubscribe(id), false);
    assert.equal(s.unsubscribe("unknown"), false);
    s.removeAll();
    assert.equal(s.size, 0);
});

test("Req: the worker answers; no worker rejects instead of throwing", async () => {
    const r = new Req<number, number>(undefined, "REQ_DOUBLE");
    assert.equal(r.hasListener, false);
    const pending = r.request(1);                       // must not throw synchronously
    await assert.rejects(pending, /No worker registered in REQ_DOUBLE/);
    r.listener = async n => n * 2;
    assert.equal(await r.request(21), 42);
    r.listener = async () => { throw new Error("down"); };
    await assert.rejects(r.request(1), /down/);
});
