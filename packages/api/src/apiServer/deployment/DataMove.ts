// `bmfk data move [--yes]` — moves the project data folders from /var/bmfk (the 1.0/1.1 default) to
// ~/.bmfk of the current user. Without --yes it only shows the plan.
//
// Each project folder is moved (renamed, or copied and then removed when /var and the home are on
// different disks) and a link is left in its place: paths already written into deployed code (the
// secrets file a slot reads) and into the deployer's own Main.js keep working until the next deploy.
// Afterwards nothing uses /var/bmfk as the default any more (links don't count), so the apps, the
// deployer and `bmfk ps` all pick ~/.bmfk.
//
// Stop the deployer and the apps first: a process writing into a folder while it moves loses data.

import fs from "fs";
import path from "path";
import { LEGACY_ROOT, homeRoot } from "../helper/AppDataPath";
import { palette } from "./cliCommon";

export interface IMoveItem { name: string; from: string; to: string; action: "move" | "skip"; why?: string }

export function planMove(from = LEGACY_ROOT, to = homeRoot()): { items: IMoveItem[]; error?: string } {
    if (!to) return { items: [], error: "this user has no home folder — keep /var/bmfk or set BMFK_DATA_DIR" };
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(from, { withFileTypes: true }); }
    catch { return { items: [], error: `${from} doesn't exist or can't be read — nothing to move` }; }
    const items: IMoveItem[] = [];
    for (const e of entries) {
        const src = path.join(from, e.name), dst = path.join(to, e.name);
        const item: IMoveItem = { name: e.name, from: src, to: dst, action: "move" };
        if (e.isSymbolicLink()) Object.assign(item, { action: "skip", why: "already a link (moved before)" });
        else if (!e.isDirectory()) Object.assign(item, { action: "skip", why: "not a folder" });
        else {
            try { fs.accessSync(src, fs.constants.W_OK | fs.constants.R_OK); }
            catch { Object.assign(item, { action: "skip", why: "belongs to another user" }); }
            if (item.action === "move" && fs.existsSync(dst) && fs.readdirSync(dst).length > 0)
                Object.assign(item, { action: "skip", why: `${dst} already has files — merge by hand` });
        }
        items.push(item);
    }
    try { fs.accessSync(from, fs.constants.W_OK); }
    catch {
        for (const i of items) if (i.action === "move") Object.assign(i, { action: "skip", why: `can't leave a link: ${from} isn't writable by this user` });
    }
    return { items };
}

// Sockets are left behind: the app makes a new one at start.
const notSocket = (src: string) => { try { return !fs.lstatSync(src).isSocket(); } catch { return true; } };

function countFiles(dir: string): number {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSocket()) continue;
        n += e.isDirectory() ? countFiles(path.join(dir, e.name)) + 1 : 1;
    }
    return n;
}

export function moveOne(item: IMoveItem) {
    fs.mkdirSync(path.dirname(item.to), { recursive: true, mode: 0o700 });
    if (fs.existsSync(item.to)) fs.rmdirSync(item.to);   // empty (planMove checked)
    try {
        fs.renameSync(item.from, item.to);
    } catch (e: any) {
        if (e?.code !== "EXDEV") throw e;
        // Another disk: copy, check, then remove the original.
        fs.cpSync(item.from, item.to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: notSocket });
        if (countFiles(item.from) !== countFiles(item.to)) throw new Error(`copy of ${item.from} is incomplete — the original is kept`);
        fs.rmSync(item.from, { recursive: true });
    }
    fs.chmodSync(item.to, 0o700);
    fs.symlinkSync(item.to, item.from, "dir");
}

export async function DataMove(args: string[]): Promise<number> {
    const c = palette();
    const yes = args.includes("--yes") || args.includes("-y");
    if (args.some(a => a !== "--yes" && a !== "-y")) { console.error("Usage: bmfk data move [--yes]"); return 1; }
    const plan = planMove();
    if (plan.error) { console.error(c.red("✗ ") + plan.error); return 1; }
    const to = homeRoot()!;
    console.log(c.bold(`Data folders: ${LEGACY_ROOT} → ${to}`));
    for (const i of plan.items)
        console.log(i.action === "move" ? `  ${c.green("→")} ${i.name}` : `  ${c.dim("–")} ${i.name}  ${c.dim(i.why ?? "")}`);
    const moving = plan.items.filter(i => i.action === "move");
    if (!moving.length) { console.log(c.dim("\n  Nothing to move.")); return 0; }
    if (!yes) {
        console.log(`\n  Stop the deployer and the apps that use these folders, then: ${c.bold("bmfk data move --yes")}`);
        console.log(c.dim("  Each folder leaves a link behind, so paths already in deployed code keep working."));
        return 0;
    }
    let failed = 0;
    for (const i of moving) {
        try { moveOne(i); console.log(`  ${c.green("✓")} ${i.name}`); }
        catch (e: any) { failed++; console.error(`  ${c.red("✗")} ${i.name}: ${e?.message ?? e}`); }
    }
    console.log("");
    console.log("  Next:");
    console.log(`  1. Start the deployer and the apps again — they now use ${to}.`);
    console.log(`  2. Deploy each project once: the paths written into its code move to ${to} too.`);
    console.log(`  3. Then the links in ${LEGACY_ROOT} can go: ${c.bold(`sudo rm -r ${LEGACY_ROOT}`)} (after checking it holds only links).`);
    return failed ? 1 : 0;
}
