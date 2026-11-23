import fs from "fs";
import path from "path";
import { getBlueGreenActiveState, onLiveChange } from "../deployment/BlueGreenState";

// Where a running app keeps what must survive restarts and deploys: never inside the deployed code
// (a deploy cleans the destination).
//
// Default: /var/bmfk/<project>/… (BMFK_DATA_DIR overrides the root). One folder per project, so
// several services on one server — on different ports, under different users — never share files,
// while the two blue-green slots of one project (different ports too) do: history follows the live slot.
//
// The project is named by the deployer: its project name is written into .bluegreen.json and into
// the deployed package.json "name" on every deploy (DeployerService._stampProjectName). Off the
// deployer (a dev machine) package.json "name" is used as is, then the project folder's name.

export const APP_DATA_ROOT_ENV = "BMFK_DATA_DIR";
const DEFAULT_ROOT = "/var/bmfk";

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

    /** /var/bmfk/<name> for a project named by someone else (the deployer, for the apps it deploys). */
    projectDir(name: string): string {
        return path.join(AppData.root(), fileSafe(name) || "app");
    },

    root(): string {
        const env = process.env[APP_DATA_ROOT_ENV];
        return path.resolve(env && env.length > 0 ? env : DEFAULT_ROOT);
    },

    /**
     * /var/bmfk/<project>/<sub>, created (0700) if missing. null when it can't be created — no rights
     * on /var (a dev machine, an unprivileged user): the caller falls back and says so.
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

// The pre-/var/bmfk location, beside the deployed code: <project>/<name><ext> for blue-green (shared
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
