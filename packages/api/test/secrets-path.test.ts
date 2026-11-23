import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { SecretsInjector } from "../src/apiServer/deployment/SecretsInjector";
import { AppData } from "../src/apiServer/helper/AppDataPath";

test("secrets: {} with no secrets_dir → the project's data folder", () => {
    const root = AppData.root();
    assert.equal(SecretsInjector.resolvePath("shop", "blue", {} as any, "", "/var/node/shop").path,
        path.join(root, "shop", "secrets-blue.json"));
    assert.equal(SecretsInjector.resolvePath("shop", null, {} as any, undefined, "/var/node/shop").path,
        path.join(root, "shop", "secrets.json"));
});

test("secrets_dir and secrets.dir still win", () => {
    assert.equal(SecretsInjector.resolvePath("shop", "blue", {} as any, "/etc/s", "/var/node/shop").path, "/etc/s/shop-blue.json");
    assert.equal(SecretsInjector.resolvePath("shop", null, { dir: "/opt/x" } as any, "/etc/s", "/var/node/shop").path, "/opt/x/shop.json");
});
