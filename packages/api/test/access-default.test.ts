import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { APIService, REQ_MONITOR_USERS } from "../src/apiServer/APIService";
import { AppData } from "../src/apiServer/helper/AppDataPath";
import { startApi, exitWhenDone } from "./helpers";

exitWhenDone();

test('access "" (the default) reads <data folder>/<project>/access.json', async () => {
    const file = APIService.defaultAccessFile();
    assert.equal(file, path.join(process.env.BMFK_DATA_DIR!, AppData.project(), "access.json"));
    fs.writeFileSync(file, JSON.stringify({ monitor: [{ login: "ops", password: "scrypt$16384$8$1$AAAA$BBBB", role: "it" }] }));
    await startApi(18812);
    assert.deepEqual((await REQ_MONITOR_USERS.request()).map(u => u.login), ["ops"]);
});
