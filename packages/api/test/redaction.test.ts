import { test } from "node:test";
import assert from "node:assert/strict";
import { LogService, LOG_LEVEL, getDefaultLogOptions } from "../src/apiServer/LogService";
import { APIService } from "../src/apiServer/APIService";
import { Http } from "../src/apiServer/http/Http";

test("card fields are replaced whole", () => {
    const out = LogService.sanitizeDeep({ pan: "4111111111111111", cardNumber: "5555555555554444", amount: 100 });
    assert.equal(out.pan, "<REDACTED>");
    assert.equal(out.cardNumber, "<REDACTED>");
    assert.equal(out.amount, 100);
});

test("sensitive authentication data is redacted", () => {
    const out = LogService.sanitizeDeep({ cvv: "123", cvc: "456", pin: "1234" });
    for (const v of Object.values(out)) assert.equal(v, "<REDACTED>");
});

test("a PAN inside free text keeps only the last four digits", () => {
    const s = LogService.sanitize("card 5555555555554444 declined");
    assert.ok(!s.includes("5555555555554444"));
    assert.ok(s.includes("4444"));
});

test("a 16-digit number that fails Luhn is left alone", () => {
    // Order numbers and timestamps must stay readable.
    assert.ok(LogService.sanitize("order 1234567890123456").includes("1234567890123456"));
});

test("secrets are redacted", () => {
    const out = LogService.sanitizeDeep({ password: "p", token: "t", authorization: "Bearer x", apiKey: "k" });
    for (const v of Object.values(out)) assert.ok(String(v).includes("REDACTED"));
});

test("bearer tokens, JWTs and connection-string passwords in text are redacted", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const s = LogService.sanitize(`Bearer abc.def ${jwt} mysql://u:secret@db`);
    assert.ok(!s.includes("abc.def"));
    assert.ok(!s.includes(jwt));
    assert.ok(!s.includes("secret@"));
});

test("PEM blocks are redacted", () => {
    const s = LogService.sanitize("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----");
    assert.ok(!s.includes("MIIEvQIBADANBg"));
});

test("the logged object itself is never modified", () => {
    const input = { pan: "4111111111111111", nested: { password: "p" } };
    LogService.sanitizeDeep(input);
    assert.equal(input.pan, "4111111111111111");
    assert.equal(input.nested.password, "p");
});

// A cut through a value used to leave half of it readable: the rules need the whole value, so redaction
// must come first. These bodies put the secret exactly where the 255 / 500 character cuts fall.
const PAN = "4111111111111111";
const atTotalCut = { a: "x".repeat(200), b: "x".repeat(200), c: "x".repeat(55), password: "SuperSecretPassw0rd" };
const panAtTotalCut = { a: "y".repeat(200), b: "y".repeat(200), c: "y".repeat(62), card: PAN };
const panAtStringCut = { note: "z".repeat(245) + " " + PAN + " rest" };

test("journals: a secret where the text is cut is still redacted", () => {
    for (const body of [atTotalCut, panAtTotalCut, panAtStringCut]) {
        const s = LogService.snapshot(body);
        assert.ok(!s.includes("SuperSecret"), s.slice(-60));
        assert.ok(!/4111111/.test(s), s.slice(-60));
    }
});

test("incoming and outgoing journals use the same redact-then-cut", () => {
    const api = Object.create(APIService.prototype) as APIService;
    for (const body of [atTotalCut, panAtTotalCut, panAtStringCut]) {
        const incoming = api.checkDataLength(body);
        const outgoing = (Http as any)._truncate(body);
        for (const s of [incoming, outgoing]) {
            assert.ok(!s.includes("SuperSecret"));
            assert.ok(!/4111111/.test(s));
        }
    }
});

test("a long INFO log line is redacted before it is shortened", () => {
    const log = new LogService({ ...getDefaultLogOptions(), textLimit: 40 });
    const text = log.createText("x".repeat(30) + " card " + PAN, LOG_LEVEL.INFO);
    assert.ok(!/4111111/.test(text), text);
});
