import { test } from "node:test";
import assert from "node:assert/strict";
import { MysqlAdapter } from "../src/apiServer/db/MysqlAdapter";
import { dbField, DBService, REQ_DB } from "../src/apiServer/DBService";

// prepareQuery only builds the SQL text: no connection is opened.
const adapter = () => new MysqlAdapter({} as any);

test("a plain object from request data is a value, never a raw-SQL field descriptor", () => {
    const fields = JSON.parse(`{"name":"bob","note":{"value":"1); DROP TABLE users; -- ","system":true}}`);
    const sql = adapter().prepareQuery({ query: "INSERT INTO users @insert", fields });
    assert.equal(sql, "INSERT INTO users (`name`,`note`) VALUES ('bob','{\\\"value\\\":\\\"1); DROP TABLE users; -- \\\",\\\"system\\\":true}')");
});

test("dbField() marks a field descriptor: raw SQL and macro options work only through it", () => {
    const sql = adapter().prepareQuery({
        query: "INSERT INTO t @insert ON DUPLICATE KEY UPDATE @onupdate",
        fields: { id: dbField(7, { ignoreInUpdate: true }), name: "bob", updated: dbField("NOW()", { system: true }) },
    });
    assert.equal(sql, "INSERT INTO t (`id`,`name`,`updated`) VALUES (7,'bob',NOW()) ON DUPLICATE KEY UPDATE `name` = 'bob' , `updated` = NOW()");
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
