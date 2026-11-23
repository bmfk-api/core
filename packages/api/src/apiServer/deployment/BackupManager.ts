// Deploy backups: a full copy of what a deploy is about to overwrite, kept next to it.
//
// Layout — the backup goes one level ABOVE the directory being overwritten:
//   regular project  /var/node/sms        → /var/node/2026-10-15_12-00-00-sms
//   blue-green slot  /var/node/gw/blue    → /var/node/gw/2026-10-15_12-00-00-gw-blue
// Several projects can share a parent directory, so a backup is recognised by its metadata file
// (exact project match), never by name matching — "gateway" must not claim "gateway-v2"'s backups.
//
// A backup is a plain copy (node_modules included), so restoring is a plain copy back — no network,
// no `npm ci`, nothing that can fail in the middle of an incident.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const BACKUP_META = ".bmfk-backup.json";
export const MAX_BACKUPS = 10;

// <stamp>[_<n>]-<label>. Anything else in the directory (projects, partial copies) is ignored.
const NAME_RE = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:_(\d+))?-([A-Za-z0-9._-]+)$/;
const PARTIAL_PREFIX = ".partial-";

export type TBackupSlot = "blue" | "green" | null;

export interface IBackupMeta {
    version: 1;
    project: string;
    slot: TBackupSlot;
    createdAt: number;
    user: string;
    reason: "deploy" | "pre-restore";
    appVersion: string | null;   // package.json version of the code that was backed up
}

export interface IBackupInfo extends IBackupMeta {
    name: string;
    sizeKb: number | null;
}

export class BackupManager {

    static fileSafe(s: string): string {
        const v = String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
        return v.length > 0 ? v.slice(0, 80) : "project";
    }

    static stamp(d = new Date()): string {
        const p = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    }

    static isValidName(name: string): boolean {
        return typeof name === "string" && NAME_RE.test(name);
    }

    private static hasContent(dir: string): boolean {
        try { return fs.readdirSync(dir).some(f => f !== "__tmp"); }
        catch { return false; }
    }

    private static readMeta(dir: string): IBackupMeta | null {
        try {
            const m = JSON.parse(fs.readFileSync(path.join(dir, BACKUP_META), "utf-8"));
            return m && typeof m.project === "string" ? m : null;
        } catch { return null; }
    }

    private static readAppVersion(dir: string): string | null {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"))?.version;
            return typeof v === "string" ? v : null;
        } catch { return null; }
    }

    private static assertSafeRoot(root: string) {
        const r = path.resolve(root);
        if (r === path.parse(r).root || r.length < 5)
            throw new Error(`refusing to keep backups in "${r}"`);
    }

    /**
     * Copy everything in `target` into a new backup next to it. Returns the backup name, or null
     * when there was nothing to save (first deploy). Copies into a hidden `.partial-*` directory
     * and renames only once complete, so a crash never leaves something that looks like a backup.
     */
    static async create(target: string, project: string, slot: TBackupSlot, user: string,
                        reason: IBackupMeta["reason"]): Promise<string | null> {
        target = path.resolve(target);
        if (!fs.existsSync(target) || !BackupManager.hasContent(target)) return null;

        const root = path.dirname(target);
        BackupManager.assertSafeRoot(root);

        const label = BackupManager.fileSafe(slot ? `${project}-${slot}` : project);
        const st = BackupManager.stamp();
        let name = `${st}-${label}`;
        for (let n = 2; fs.existsSync(path.join(root, name)); n++) name = `${st}_${n}-${label}`;

        const finalDir = path.join(root, name);
        const partial = path.join(root, PARTIAL_PREFIX + name);
        try {
            await fs.promises.mkdir(partial, { recursive: true });
            // -a keeps permissions, timestamps and symlinks; "target/." copies the contents.
            await execFileAsync("cp", ["-a", target + "/.", partial + "/"]);
            await fs.promises.rm(path.join(partial, "__tmp"), { recursive: true, force: true });
            const meta: IBackupMeta = {
                version: 1, project, slot, createdAt: Date.now(), user, reason,
                appVersion: BackupManager.readAppVersion(target),
            };
            await fs.promises.writeFile(path.join(partial, BACKUP_META), JSON.stringify(meta, null, 2), "utf-8");
            await fs.promises.rename(partial, finalDir);
        } catch (e) {
            await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => {});
            throw e;
        }
        return name;
    }

    /** Backups of `project` in `root`, newest first. */
    static async list(root: string, project: string, withSize = false): Promise<IBackupInfo[]> {
        root = path.resolve(root);
        if (!fs.existsSync(root)) return [];
        const out: IBackupInfo[] = [];
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
            const meta = BackupManager.readMeta(path.join(root, e.name));
            if (!meta || meta.project !== project) continue;
            out.push({ ...meta, name: e.name, sizeKb: null });
        }
        out.sort((a, b) => b.createdAt - a.createdAt);

        if (withSize && out.length > 0) {
            // One `du` for all of them — walking node_modules from JS would be far slower.
            try {
                const { stdout } = await execFileAsync("du", ["-sk", ...out.map(b => path.join(root, b.name))], { timeout: 20000 });
                for (const line of String(stdout).split("\n")) {
                    const m = line.match(/^(\d+)\s+(.+)$/);
                    if (!m) continue;
                    const item = out.find(b => path.join(root, b.name) === m[2].trim());
                    if (item) item.sizeKb = parseInt(m[1], 10);
                }
            } catch { /* size is informational only */ }
        }
        return out;
    }

    /** Keep the newest `keep` backups of `project`; `protect` names are never removed. */
    static async prune(root: string, project: string, keep = MAX_BACKUPS, protect: string[] = []): Promise<string[]> {
        const all = await BackupManager.list(root, project);
        const removed: string[] = [];
        let kept = 0;
        for (const b of all) {
            if (kept < keep || protect.includes(b.name)) { kept++; continue; }
            await fs.promises.rm(path.join(path.resolve(root), b.name), { recursive: true, force: true });
            removed.push(b.name);
        }
        return removed;
    }

    /** Resolve a client-supplied backup name to a directory, or null. Never trusts the name as a path. */
    static resolve(root: string, project: string, name: string): { dir: string, meta: IBackupMeta } | null {
        if (!BackupManager.isValidName(name)) return null;
        const r = path.resolve(root);
        const dir = path.resolve(r, name);
        if (path.dirname(dir) !== r) return null;
        const meta = BackupManager.readMeta(dir);
        if (!meta || meta.project !== project) return null;
        return { dir, meta };
    }

    /**
     * Put a backup back in place of `target`. The copy is staged next to the target and swapped in
     * with renames, so the live directory is never half-written or empty — a process restarting
     * mid-restore finds either the old tree or the new one.
     */
    static async restoreInto(backupDir: string, target: string) {
        target = path.resolve(target);
        const staging = target + ".restore-tmp";
        const old = target + ".restore-old";
        await fs.promises.rm(staging, { recursive: true, force: true });
        await fs.promises.rm(old, { recursive: true, force: true });

        await fs.promises.mkdir(staging, { recursive: true });
        try {
            await execFileAsync("cp", ["-a", backupDir + "/.", staging + "/"]);
            await fs.promises.rm(path.join(staging, BACKUP_META), { force: true });
        } catch (e) {
            await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
            throw e;
        }

        const hadTarget = fs.existsSync(target);
        if (hadTarget) await fs.promises.rename(target, old);
        try {
            await fs.promises.rename(staging, target);
        } catch (e) {
            if (hadTarget) await fs.promises.rename(old, target).catch(() => {});
            throw e;
        }
        await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
    }
}
