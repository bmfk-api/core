import fs from "fs";
import os from "os";
import path from "path";
import { getBlueGreenActiveState, onLiveChange } from "../deployment/BlueGreenState";

// Where a running app keeps what must survive restarts and deploys: never inside the deployed code
// (a deploy cleans the destination).
//
// The root, in this order:
//   1. BMFK_DATA_DIR, when set;
//   2. /var/bmfk — the 1.0/1.1 default — while it holds a project folder this user can write to
//      (a real folder, not a link left by `bmfk data move`), said once in the log;
//   3. ~/.bmfk of the user the process runs as (/var/bmfk when that user has no home).
// Inside: one folder per project (0700), so several services on one server — on different ports,
// under different users — never share files, while the two blue-green slots of one project (different
// ports too) do: history follows the live slot.
//
// The project is named by the deployer: its project name is written into .bluegreen.json and into
// the deployed package.json "name" on every deploy (DeployerService._stampProjectName). Off the
// deployer (a dev machine) package.json "name" is used as is, then the project folder's name.

export const APP_DATA_ROOT_ENV = "BMFK_DATA_DIR";
export const LEGACY_ROOT = "/var/bmfk";

// The home folder root, or null when the user has none worth the name.
export function homeRoot(): string | null {
    let home: string;
    try { home = os.homedir(); } catch { return null; }
    return home && path.isAbsolute(home) && home !== "/" ? path.join(home, ".bmfk") : null;
}

// /var/bmfk still in use: it holds a real project folder this user can write to.
export function legacyRootInUse(root = LEGACY_ROOT): boolean {
    try {
        fs.accessSync(root, fs.constants.W_OK);
        for (const e of fs.readdirSync(root, { withFileTypes: true }))
            if (e.isDirectory() && !e.isSymbolicLink()) {
                try { fs.accessSync(path.join(root, e.name), fs.constants.W_OK); return true; } catch { }
            }
    } catch { }
    return false;
}

let defaultRoot: string | null = null;
function resolveDefaultRoot(): string {
    if (defaultRoot) return defaultRoot;
    const home = homeRoot();
    if (legacyRootInUse() || !home) {
        defaultRoot = LEGACY_ROOT;
        if (home) console.warn(`bmfk: data folder ${LEGACY_ROOT} (the 1.0/1.1 default) — \`bmfk data move\` moves it to ${home}`);
    } else defaultRoot = home;
    return defaultRoot;
}

const fileSafe = (s: string) => s.replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 64);

interface ILocation { root: string; bluegreen: boolean; project: string | null }

// Walks up from the entry script: a .bluegreen.json marks a slot (its parent is the project folder);
// otherwise the nearest package.json marks the project folder.
function locate(): ILocation {
    const main = require.main?.filename ?? process.argv[1] ?? process.cwd();
    let dir = path.dirname(path.resolve(main));
    let packageRoot: string | null = null;
    for (let i = 0; i < 12; i++) {
        const bg = path.join(dir, ".bluegreen.json");
        if (fs.existsSync(bg)) {
            let project: string | null = null;
            try { project = JSON.parse(fs.readFileSync(bg, "utf-8"))?.project ?? null; } catch { }
            return { root: path.dirname(dir), bluegreen: true, project };
        }
        if (!packageRoot && fs.existsSync(path.join(dir, "package.json"))) packageRoot = dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    const root = packageRoot ?? process.cwd();
    let project: string | null = null;
    try { project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))?.name ?? null; } catch { }
    return { root, bluegreen: false, project };
}

export const AppData = {
    project(): string {
        const loc = locate();
        return fileSafe(loc.project ?? "") || fileSafe(path.basename(loc.root)) || "app";
    },

    /** <root>/<name> for a project named by someone else (the deployer, for the apps it deploys). */
    projectDir(name: string): string {
        return path.join(AppData.root(), fileSafe(name) || "app");
    },

    root(): string {
        const env = process.env[APP_DATA_ROOT_ENV];
        return path.resolve(env && env.length > 0 ? env : resolveDefaultRoot());
    },

    /**
     * <root>/<project>/<sub>, created (0700) if missing. null when it can't be created (no rights): the
     * caller falls back and says so.
     */
    dir(sub: string): string | null {
        const dir = path.join(AppData.root(), AppData.project(), sub);
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.accessSync(dir, fs.constants.W_OK);
            return dir;
        } catch {
            return null;
        }
    },
};

// The location before data folders, beside the deployed code: <project>/<name><ext> for blue-green (shared
// by both slots), <parent>/<name>.<folder><ext> otherwise.
export function appDataPath(name: string, ext = ""): string {
    const loc = locate();
    if (loc.bluegreen) return path.join(loc.root, name + ext);
    return path.join(path.dirname(loc.root), `${name}.${path.basename(loc.root)}${ext}`);
}

/**
 * Tells whether this process should write shared state files (metrics, threats): one writer per
 * project folder. Not blue-green → yes, after the first state check; blue-green → only the live slot,
 * re-told on every switch. pm2 cluster workers other than instance 0 never write (cb is not called).
 */
export function onWriterChange(cb: (writer: boolean) => void): boolean {
    const worker = process.env.NODE_APP_INSTANCE;
    if (worker !== undefined && worker !== "0") return false;
    onLiveChange(live => cb(live));
    getBlueGreenActiveState().catch(() => {});   // one check of our own: the watcher may be off (blueGreenWatchMs: 0)
    return true;
}
