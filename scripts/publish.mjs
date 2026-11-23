// npm run publish [-- X.Y.Z-rc.N]: bumps @bmfk/api to the top CHANGELOG section, commits, signs the tag vX.Y.Z
// and pushes both. Nothing is published from here: the tag starts release.yml, which publishes after approval.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const PKG = "packages/api/package.json";
const CHANGELOG = "packages/api/CHANGELOG.md";
const FILES = [PKG, CHANGELOG, "package-lock.json"];

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf-8" }).trim();
const step = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const fail = msg => { console.error(`publish: ${msg}`); process.exit(1); };

if (run("git", ["branch", "--show-current"]) !== "main") fail("switch to main");
if (run("git", ["status", "--porcelain"])) fail("working tree is not clean");
step("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", "origin/main"])) fail("main differs from origin/main");

const { name, version: current } = JSON.parse(readFileSync(PKG, "utf-8"));
const changelog = readFileSync(CHANGELOG, "utf-8");
const top = changelog.match(/^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}$/m);
if (!top) fail(`no "## X.Y.Z — YYYY-MM-DD" section in ${CHANGELOG}`);
const base = top[1];
const version = process.argv[2] ?? base;
if (version !== base && !version.startsWith(`${base}-`)) fail(`${version} does not match the CHANGELOG section ${base}`);
if (version === current) fail(`${current} is already the package version — add a "## <next> — …" section to ${CHANGELOG}`);
const tag = `v${version}`;
if (run("git", ["tag", "-l", tag])) fail(`tag ${tag} already exists`);
if (spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf-8" }).stdout.trim()) fail(`${name}@${version} is already on npm`);

try {
    const today = new Date().toLocaleDateString("sv-SE");
    writeFileSync(CHANGELOG, changelog.replace(top[0], `## ${base} — ${today}`));
    step("npm", ["version", version, "-w", name, "--no-git-tag-version"]);
    step("npm", ["run", "build"]);
    step("npm", ["test"]);
    step("git", ["--no-pager", "diff", "--stat"]);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Commit ${name} ${current} → ${version}, tag ${tag} and push to origin? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") throw new Error("cancelled");
} catch (e) {
    step("git", ["checkout", "--", ...FILES]);
    fail(`${e.message} — version changes reverted`);
}

step("git", ["commit", "-S", "-m", `${name} ${version}`, "--", ...FILES]);
step("git", ["tag", "-s", tag, "-m", tag]);
step("git", ["tag", "-v", tag]);
step("git", ["push", "--atomic", "origin", "main", tag]);
console.log(`\n${tag} pushed. Approve the "npm" environment: https://github.com/bmfk-api/core/actions/workflows/release.yml`);
