import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface IFileChange {
    path: string;
    status: "added" | "removed" | "modified";
    kind: "text" | "binary" | "symlink" | "sensitive" | "large";
    sizeBefore: number | null;
    sizeAfter: number | null;
    diff?: string;           // unified diff (text files only)
    truncated?: boolean;
}

export interface IDependencyChange { name: string, section: string, before: string | null, after: string | null }

export interface IReviewDiff {
    baseline: { at: number, version: string | null } | null;   // null → first reviewed deploy
    versionBefore: string | null;
    versionAfter: string | null;
    dependencies: IDependencyChange[];
    files: IFileChange[];
    unchanged: number;
    limited: string | null;    // why some content isn't shown (budget, file count…)
}

interface IEntry { kind: "file" | "symlink", size: number, hash: string, target?: string }

// What changes between the last deployed archive and the one waiting for review. Both are the RAW
// archives — deployed folders have config values (secrets) substituted and are never read here.
export class ReviewDiff {
    static MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
    static MAX_FILES = 5000;
    static MAX_TEXT_FILE = 512 * 1024;
    static MAX_FILE_DIFF = 200 * 1024;
    static MAX_TOTAL_DIFF = 2 * 1024 * 1024;

    // Listed, never shown: the page must not become a way to read credentials.
    static SENSITIVE = [/(^|\/)\.env(\..*)?$/i, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
        /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i, /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i];

    private static cache = new Map<string, IReviewDiff>();

    static async compute(baseline: string | null, pending: string): Promise<IReviewDiff> {
        const key = `${baseline ? await ReviewDiff.sha(baseline) : "-"}:${await ReviewDiff.sha(pending)}`;
        const hit = ReviewDiff.cache.get(key);
        if (hit) return hit;

        const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "review-diff-"));
        try {
            await fs.promises.chmod(tmp, 0o700);
            for (const f of [baseline, pending])
                if (f && (await fs.promises.stat(f)).size > ReviewDiff.MAX_ARCHIVE_BYTES)
                    throw new Error(`archive is larger than ${ReviewDiff.MAX_ARCHIVE_BYTES / 1048576} MB — too large to compare`);

            const before = path.join(tmp, "a"), after = path.join(tmp, "b");
            await fs.promises.mkdir(before); await fs.promises.mkdir(after);
            if (baseline) await execFileAsync("tar", ["-xzf", baseline, "-C", before]);
            await execFileAsync("tar", ["-xzf", pending, "-C", after]);

            const a = baseline ? await ReviewDiff.walk(before) : new Map<string, IEntry>();
            const b = await ReviewDiff.walk(after);
            const result = await ReviewDiff.compare(before, after, a, b);
            result.baseline = baseline ? { at: (await fs.promises.stat(baseline)).mtimeMs, version: result.versionBefore } : null;

            ReviewDiff.cache.set(key, result);
            if (ReviewDiff.cache.size > 10) ReviewDiff.cache.delete(ReviewDiff.cache.keys().next().value!);
            return result;
        } finally {
            await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
    }

    private static sha(file: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const h = crypto.createHash("sha256");
            fs.createReadStream(file).on("data", d => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
        });
    }

    // Files and symlinks by relative path. Symlinks are recorded, never followed.
    private static async walk(root: string): Promise<Map<string, IEntry>> {
        const out = new Map<string, IEntry>();
        const visit = async (dir: string) => {
            for (const d of await fs.promises.readdir(dir, { withFileTypes: true })) {
                if (out.size >= ReviewDiff.MAX_FILES) return;
                const abs = path.join(dir, d.name);
                const rel = path.relative(root, abs).split(path.sep).join("/");
                if (d.isSymbolicLink()) {
                    const target = await fs.promises.readlink(abs);
                    out.set(rel, { kind: "symlink", size: 0, hash: "link:" + target, target });
                } else if (d.isDirectory()) {
                    await visit(abs);
                } else if (d.isFile()) {
                    const buf = await fs.promises.readFile(abs);
                    out.set(rel, { kind: "file", size: buf.length, hash: crypto.createHash("sha256").update(buf).digest("hex") });
                }
            }
        };
        await visit(root);
        return out;
    }

    private static isText(buf: Buffer): boolean {
        return !buf.subarray(0, 8192).includes(0);
    }

    private static async compare(beforeRoot: string, afterRoot: string, a: Map<string, IEntry>, b: Map<string, IEntry>): Promise<IReviewDiff> {
        const files: IFileChange[] = [];
        let unchanged = 0, budget = ReviewDiff.MAX_TOTAL_DIFF, limited: string | null = null;
        if (a.size >= ReviewDiff.MAX_FILES || b.size >= ReviewDiff.MAX_FILES)
            limited = `more than ${ReviewDiff.MAX_FILES} files — the list is incomplete`;

        const paths = Array.from(new Set([...a.keys(), ...b.keys()])).sort();
        for (const p of paths) {
            const x = a.get(p), y = b.get(p);
            if (x && y && x.hash === y.hash) { unchanged++; continue; }
            const change: IFileChange = {
                path: p,
                status: !x ? "added" : !y ? "removed" : "modified",
                kind: "text",
                sizeBefore: x ? x.size : null,
                sizeAfter: y ? y.size : null,
            };
            if (x?.kind === "symlink" || y?.kind === "symlink") {
                change.kind = "symlink";
                change.diff = `${x?.target ? "- → " + x.target + "\n" : ""}${y?.target ? "+ → " + y.target + "\n" : ""}`;
            } else if (ReviewDiff.SENSITIVE.some(re => re.test(p))) {
                change.kind = "sensitive";
            } else if ((x?.size ?? 0) > ReviewDiff.MAX_TEXT_FILE || (y?.size ?? 0) > ReviewDiff.MAX_TEXT_FILE) {
                change.kind = "large";
            } else {
                const fa = x ? path.join(beforeRoot, p) : null, fb = y ? path.join(afterRoot, p) : null;
                const ba = fa ? await fs.promises.readFile(fa) : Buffer.alloc(0), bb = fb ? await fs.promises.readFile(fb) : Buffer.alloc(0);
                if (!ReviewDiff.isText(ba) || !ReviewDiff.isText(bb)) change.kind = "binary";
                else if (budget <= 0) { limited = limited ?? "the diff is too large — some files show no content"; }
                else {
                    let d = await ReviewDiff.unified(fa, fb, p);
                    if (d.length > Math.min(ReviewDiff.MAX_FILE_DIFF, budget)) {
                        d = d.slice(0, Math.min(ReviewDiff.MAX_FILE_DIFF, budget));
                        d = d.slice(0, d.lastIndexOf("\n") + 1);
                        change.truncated = true;
                    }
                    budget -= d.length;
                    change.diff = d;
                }
            }
            files.push(change);
        }

        const pkgA = ReviewDiff.readJson(path.join(beforeRoot, "package.json"));
        const pkgB = ReviewDiff.readJson(path.join(afterRoot, "package.json"));
        const dependencies: IDependencyChange[] = [];
        for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            const da = pkgA?.[section] ?? {}, db = pkgB?.[section] ?? {};
            for (const name of Array.from(new Set([...Object.keys(da), ...Object.keys(db)])).sort()) {
                const before = typeof da[name] === "string" ? da[name] : null, after = typeof db[name] === "string" ? db[name] : null;
                if (before !== after) dependencies.push({ name, section, before, after });
            }
        }
        return {
            baseline: null,
            versionBefore: typeof pkgA?.version === "string" ? pkgA.version : null,
            versionAfter: typeof pkgB?.version === "string" ? pkgB.version : null,
            dependencies, files, unchanged, limited,
        };
    }

    private static readJson(file: string): any {
        try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
    }

    // `diff -u` with clean labels; exit code 1 just means "files differ".
    private static async unified(a: string | null, b: string | null, rel: string): Promise<string> {
        const args = ["-u", "--label", a ? "a/" + rel : "/dev/null", "--label", b ? "b/" + rel : "/dev/null", a ?? "/dev/null", b ?? "/dev/null"];
        try {
            const { stdout } = await execFileAsync("diff", args, { maxBuffer: 16 * 1024 * 1024 });
            return stdout;
        } catch (e: any) {
            if (e?.code === 1 && typeof e.stdout === "string") return e.stdout;
            throw e;
        }
    }
}
