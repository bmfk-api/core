import fs from "fs";
import { AppData } from "../helper/AppDataPath";
import path from "path";
import vm from "vm";

// Config values without putting them into the deployed code.
//
// The deployer writes the project's config (merged for the slot) into a secrets file OUTSIDE the
// deploy folder, and in .js/.cjs files replaces every quoted "_{{KEY}}_" with an expression that
// reads that file — so the code, both slots, backups and archives hold a path, never a value:
//
//   GW_DB_USER: "_{{gw_db_user}}_"   →   GW_DB_USER: (<read /etc/node-secrets/app-blue.json>)("gw_db_user")
//
// The expression returns String(value), exactly what the substituted literal used to be, reads
// the file once per process, and stops the start with a clear error when the key is missing.
// Anything it can't rewrite safely falls back to plain value substitution, reported by the caller.

const PLACEHOLDER = /_\{\{([A-Za-z0-9_]+)\}\}_/g;

export interface ISecretsSettings { dir?: string, file?: string }

export class SecretsInjector {

    // Where this deploy's secrets go: <dir>/<project>[-<slot>].json, or the given file (with
    // -<slot> before its extension for blue-green, since the slots' values differ).
    static resolvePath(project: string, slot: string | null, settings: ISecretsSettings | undefined, defaultDir: string | undefined, destinationRoot: string)
        : { path?: string, error?: string } {
        const file = settings?.file?.trim(), dir = (settings?.dir?.trim() || defaultDir?.trim() || "");
        let target: string;
        if (file) {
            if (!path.isAbsolute(file)) return { error: `secrets.file must be an absolute path ("${file}")` };
            const ext = path.extname(file) || ".json";
            target = slot ? path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-${slot}${ext}`) : file;
        } else if (dir) {
            if (!path.isAbsolute(dir)) return { error: `the secrets directory must be an absolute path ("${dir}")` };
            target = path.join(dir, `${project}${slot ? "-" + slot : ""}.json`);
        } else {
            // Default: the project's data folder, next to its metrics and threats —
            // /var/bmfk/<project>/secrets[-<slot>].json. The deployer and the apps run as one user.
            target = path.join(AppData.projectDir(project), `secrets${slot ? "-" + slot : ""}.json`);
        }
        target = path.resolve(target);
        // Inside the deploy folder it would be copied into backups and wiped by unpack — the very
        // places it must stay out of.
        const root = path.resolve(destinationRoot);
        if (target === root || target.startsWith(root + path.sep))
            return { error: `the secrets file must live outside the deploy folder ("${target}" is inside "${root}")` };
        return { path: target };
    }

    static write(file: string, values: Record<string, unknown>) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(values, null, 2), { encoding: "utf-8", mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    }

    // Reads the file back the way the app will: null when it's readable and holds every key.
    static verify(file: string, values: Record<string, unknown>): string | null {
        try {
            fs.accessSync(file, fs.constants.R_OK);
            const back = JSON.parse(fs.readFileSync(file, "utf-8"));
            const missing = Object.keys(values).filter(k => !Object.prototype.hasOwnProperty.call(back, k));
            return missing.length ? `${file} lacks ${missing.join(", ")}` : null;
        } catch (e: any) {
            return `${file} is not readable: ${e?.message ?? e}`;
        }
    }

    static expression(file: string, key: string): string {
        const p = JSON.stringify(file);
        return `(function(k){var s=globalThis.__bmfkSecrets||(globalThis.__bmfkSecrets=JSON.parse(require("fs").readFileSync(${p},"utf8")));`
            + `if(!Object.prototype.hasOwnProperty.call(s,k))throw new Error("secret \\""+k+"\\" is missing in "+${p});return String(s[k]);})(${JSON.stringify(key)})`;
    }

    // Rewrites quoted literals that contain placeholders of known keys. Returns the new source and
    // whether placeholders of known keys remain outside rewritable literals (those need the old
    // value substitution). Strings are found with a small line lexer; the caller syntax-checks the
    // result, so a misread line can't ship broken code.
    static transform(source: string, keys: Set<string>, file: string): { content: string, rewritten: number, leftover: boolean } {
        let rewritten = 0, inBlockComment = false;
        const lines = source.split("\n");
        for (let n = 0; n < lines.length; n++) {
            const line = lines[n];
            if (!inBlockComment && line.indexOf("_{{") === -1) {
                // still track block comments opened on lines without placeholders
                inBlockComment = SecretsInjector.endsInBlockComment(line, false);
                continue;
            }
            // Placeholders in comments are defused, or the value substitution that follows would
            // write the secret into the code after all — as a comment.
            const defuse = (text: string) => text.replace(/_\{\{/g, "_{ {");
            let out = "", i = 0;
            while (i < line.length) {
                if (inBlockComment) {
                    const end = line.indexOf("*/", i);
                    if (end === -1) { out += defuse(line.slice(i)); i = line.length; break; }
                    out += defuse(line.slice(i, end + 2)); i = end + 2; inBlockComment = false; continue;
                }
                const c = line[i];
                if (c === "/" && line[i + 1] === "/") { out += defuse(line.slice(i)); i = line.length; break; }
                if (c === "/" && line[i + 1] === "*") { inBlockComment = true; out += "/*"; i += 2; continue; }
                if (c === '"' || c === "'" || c === "`") {
                    let j = i + 1;
                    while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
                    if (j >= line.length) { out += line.slice(i); i = line.length; break; }   // unterminated (multi-line template)
                    const literal = line.slice(i, j + 1);
                    const rep = SecretsInjector.rewriteLiteral(literal, c, keys, file);
                    if (rep !== literal) rewritten++;
                    out += rep; i = j + 1; continue;
                }
                out += c; i++;
            }
            lines[n] = out;
        }
        const content = lines.join("\n");
        let leftover = false;
        for (const m of content.matchAll(PLACEHOLDER)) if (keys.has(m[1])) { leftover = true; break; }
        return { content, rewritten, leftover };
    }

    private static endsInBlockComment(line: string, open: boolean): boolean {
        let i = 0;
        while (i < line.length) {
            if (open) { const e = line.indexOf("*/", i); if (e === -1) return true; open = false; i = e + 2; continue; }
            const c = line[i];
            if (c === "/" && line[i + 1] === "/") return false;
            if (c === "/" && line[i + 1] === "*") { open = true; i += 2; continue; }
            if (c === '"' || c === "'" || c === "`") {
                let j = i + 1;
                while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
                i = j + 1; continue;
            }
            i++;
        }
        return open;
    }

    private static rewriteLiteral(literal: string, quote: string, keys: Set<string>, file: string): string {
        const body = literal.slice(1, -1);
        if (quote === "`" && body.includes("${")) return literal;   // interpolated template: left to value substitution
        const parts: string[] = [];
        let last = 0, found = false;
        for (const m of body.matchAll(PLACEHOLDER)) {
            if (!keys.has(m[1])) continue;
            found = true;
            const before = body.slice(last, m.index);
            if (before) parts.push(quote + before + quote);
            parts.push(SecretsInjector.expression(file, m[1]));
            last = m.index! + m[0].length;
        }
        if (!found) return literal;
        const after = body.slice(last);
        if (after) parts.push(quote + after + quote);
        // Parenthesised, so `"_{{x}}_".length` or `"a" + "_{{x}}_"` keep their meaning.
        return "(" + (parts.length === 1 ? parts[0] : `""+` + parts.join("+")) + ")";
    }

    // Compiles (never runs) a CommonJS module.
    static parses(source: string): boolean {
        try {
            new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`);
            return true;
        } catch {
            return false;
        }
    }
}
