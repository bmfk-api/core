import { test } from "node:test";
import assert from "node:assert/strict";
import { MysqlAdapter } from "../src/apiServer/db/MysqlAdapter";
import { dbField, DBService, REQ_DB } from "../src/apiServer/DBService";

// prepareQuery only builds the SQL text: no connection is opened.
const adapter = () => new MysqlAdapter({} as any);

test("a plain { value, system } object never becomes raw SQL: it is refused, with a pointer to dbField()", () => {
    const fields = JSON.parse(`{"name":"bob","note":{"value":"1); DROP TABLE users; -- ","system":true}}`);
    assert.throws(() => adapter().prepareQuery({ query: "INSERT INTO users @insert", fields }), /"note".*dbField\(/);
    // What old code wrote by hand fails the same way, instead of storing {"value":"NOW()",…} as JSON.
    assert.throws(() => adapter().prepareQuery({ query: "UPDATE t SET @onupdate", fields: { updated: { value: "NOW()", system: true } } }), /dbField/);
    assert.throws(() => adapter().prepareQuery({ query: "UPDATE t SET @onupdate", fields: { id: { value: 7 } } }), /dbField/);
});

test("any other object or array is a value, stored as escaped JSON", () => {
    const fields = JSON.parse(`{"meta":{"value":"x","system":true,"other":"') OR 1=1 --"},"tags":["a","b'"]}`);
    const sql = adapter().prepareQuery({ query: "INSERT INTO t @insert", fields });
    assert.equal(sql, "INSERT INTO t (`meta`,`tags`) VALUES ('{\\\"value\\\":\\\"x\\\",\\\"system\\\":true,\\\"other\\\":\\\"\\') OR 1=1 --\\\"}','[\\\"a\\\",\\\"b\\'\\\"]')");
});

test("dbField() marks a field descriptor: raw SQL and macro options work only through it", () => {
    const sql = adapter().prepareQuery({
        query: "INSERT INTO t @insert ON DUPLICATE KEY UPDATE @onupdate",
        fields: { id: dbField(7, { ignoreInUpdate: true }), name: "bob", updated: dbField("NOW()", { system: true }) },
    });
    assert.equal(sql, "INSERT INTO t (`id`,`name`,`updated`) VALUES (7,'bob',NOW()) ON DUPLICATE KEY UPDATE `name` = 'bob' , `updated` = NOW()");
});

test("nested fields fill only a raw SQL fragment: in an escaped value they can't break out of the quotes", () => {
    const sql = adapter().prepareQuery({
        query: "SELECT * FROM t WHERE a = @v",
        fields: { v: dbField("pre-@n", { fields: { n: "x' OR 1=1 -- " } }) },
    });
    assert.equal(sql, "SELECT * FROM t WHERE a = 'pre-@n' LIMIT 100");
});

test("nested fields in a raw fragment are escaped, and 0, \"\", false, null are filled in too", () => {
    const sql = adapter().prepareQuery({
        query: "UPDATE t SET a = @v",
        fields: { v: dbField("COALESCE(@s, @z, @e, @f, @n)", { system: true, fields: { s: "x' --", z: 0, e: "", f: false, n: null } }) },
    });
    assert.equal(sql, "UPDATE t SET a = COALESCE('x\\' --', 0, '', false, NULL)");
});

test("a dbField() survives REQ_DB, and the caller's fields are left as they were", async () => {
    // "postgres" registers the listeners without connecting; the adapter is swapped for one that
    // only builds SQL (parseQueryOnly answers before any connection is used).
    const svc = new DBService({ id: "main", type: "postgres", connection: {} as any });
    await svc.init();
    svc.adapter = adapter();
    const fields = { name: "bob", updated: dbField("NOW()", { system: true }) };
    const before = JSON.stringify(fields);
    const res = await REQ_DB.request({ query: "UPDATE t SET @onupdate", fields, parseQueryOnly: true });
    assert.equal(res.data[0].query, "UPDATE t SET `name` = 'bob' , `updated` = NOW()");
    assert.equal(JSON.stringify(fields), before);
});
