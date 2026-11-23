import fs from "fs";
import path from "path";
import { palette } from "./cliCommon";

// `bmfk migrate [folder] [--write]` — moves a project from the legacy server (6.x) to @bmfk/api:
//   package.json  legacy dependency → @bmfk/api, the legacy signal package dropped,
//                 legacy CLI scripts and `node -e 'require(<legacy>).Deploy(…)'` → `bmfk …`
//   source files  every import/require of the legacy package (root or dist/…) and its signal package → @bmfk/api;
//                 number samples in validation models, which 6.x took as bounds, → 0 + $__X_max / $__X_min
// and lists what it can't change by itself: names 1.0 no longer exports, shared-key microservices, …
// Without --write it only shows the plan.

// The legacy package names: what this command looks for in a project.
const OLD_PKG = "badmfck-api-server";
const OLD_SIGNAL = "badmfck-signal";
const NEW_PKG = "@bmfk/api";
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "bin", "build", "coverage", ".git", ".next", "website"]);

export interface IMigrationFile { file: string; before: string; after: string; changes: number }
export interface IMigrationPlan { files: IMigrationFile[]; notes: string[] }

/** Names exported by the root of @bmfk/api, read from its index (.d.ts when built, .ts in the repo). */
export function rootExportNames(indexFile: string): Set<string> {
    const text = fs.readFileSync(indexFile, "utf-8");
    const names = new Set<string>();
    for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
        for (const part of m[1].split(",")) {
            const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
            if (n) names.add(n);
        }
    for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g))
        names.add(m[1]);
    return names;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) sourceFiles(path.join(dir, e.name), out);
        } else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name)) && !e.name.endsWith(".d.ts")) {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const isOld = (spec: string) => spec === OLD_PKG || spec.startsWith(OLD_PKG + "/") || spec === OLD_SIGNAL;

type Named = { name: string; alias?: string; type: boolean };

function parseNamed(braced: string): Named[] {
    return braced.split(",").map(s => s.trim()).filter(Boolean).map(s => {
        const type = /^type\s+/.test(s);
        const [name, alias] = s.replace(/^type\s+/, "").split(/\s+as\s+/).map(x => x.trim());
        return { name, alias, type };
    });
}

const printNamed = (n: Named[]) => n.map(x => (x.type ? "type " : "") + x.name + (x.alias && x.alias !== x.name ? " as " + x.alias : "")).join(", ");

/** Rewrites one source file. Returns the new text, how many places changed, and what needs a person. */
export function migrateSource(text: string, rel: string, exported: Set<string>): { text: string; changes: number; notes: string[] } {
    const notes: string[] = [];
    let changes = 0;
    const unknown = (names: string[], at: number) => {
        const missing = names.filter(n => !exported.has(n));
        if (missing.length)
            notes.push(`${rel}:${lineOf(text, at)} — not in ${NEW_PKG} 1.0: ${missing.join(", ")} (see docs: migration)`);
    };

    // import … from "<old>"
    const importRe = /import\s+(type\s+)?((?:(?!\bfrom\b|;|\bimport\b)[\s\S])+?)\s+from\s+(["'])([^"']+)\3(\s*;)?/g;
    let out = text.replace(importRe, (whole, typeOnly: string | undefined, spec: string, _q, from: string, semi: string | undefined, at: number) => {
        if (!isOld(from)) return whole;
        spec = spec.trim();
        const deep = from !== OLD_PKG && from !== OLD_SIGNAL;
        const star = spec.match(/^\*\s+as\s+([\w$]+)$/);
        if (star) {
            changes++;
            if (new RegExp(`\\b${star[1]}\\.default\\b`).test(text))
                notes.push(`${rel}:${lineOf(text, at)} — ${star[1]}.default: ${NEW_PKG} has no default export; use the named export`);
            return `import ${typeOnly ?? ""}* as ${star[1]} from "${NEW_PKG}"${semi ?? ""}`;
        }
        const m = spec.match(/^([\w$]+)?\s*,?\s*(?:\{([\s\S]*)\})?$/);
        if (!m) {
            notes.push(`${rel}:${lineOf(text, at)} — import from "${from}" not understood; change it by hand`);
            return whole;
        }
        const named = m[2] !== undefined ? parseNamed(m[2]) : [];
        if (m[1]) {
            // A default import: DefaultErrors (dist/…/DefaultErrors) and Signal (legacy signal package) have named twins.
            if (from === OLD_SIGNAL || /\/Signal$/.test(from)) named.unshift({ name: "Signal", alias: m[1], type: false });
            else if (/structures\/DefaultErrors$/.test(from)) named.unshift({ name: "DefaultErrors", alias: m[1], type: false });
            else {
                notes.push(`${rel}:${lineOf(text, at)} — default import "${m[1]}" from "${from}": ${NEW_PKG} has none; import the named export`);
                return whole;
            }
        } else if (deep && named.length === 0) {
            return whole;
        }
        unknown(named.map(n => n.name), at);
        changes++;
        return `import ${typeOnly ?? ""}{ ${printNamed(named)} } from "${NEW_PKG}"${semi ?? ""}`;
    });

    // const { a, b } = require("<old>")  — names checked, then every remaining specifier
    for (const m of out.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\((["'])([^"']+)\2\)/g))
        if (isOld(m[3])) unknown(m[1].split(",").map(s => s.trim().split(":")[0].trim()).filter(Boolean), m.index ?? 0);
    for (const m of out.matchAll(/require\((["'])([^"']+)\1\)\.default\b/g))
        if (isOld(m[2])) notes.push(`${rel}:${lineOf(out, m.index ?? 0)} — require("${m[2]}").default: use the named export of ${NEW_PKG}`);
    out = out.replace(/(require\(|import\(|from\s+)(["'])([^"']+)\2/g, (whole, head: string, q: string, spec: string) => {
        if (!isOld(spec)) return whole;
        changes++;
        return `${head}${q}${NEW_PKG}${q}`;
    });

    // What only a person can decide.
    for (const m of out.matchAll(/\bsecurityKey\s*:/g))
        notes.push(`${rel}:${lineOf(out, m.index ?? 0)} — securityKey: shared-key microservice calls are gone; give the caller and the host keys (npx bmfk ms-key: kid, privateKey, hostPublicKey on the client; privateKey, clients on the host)`);
    for (const m of out.matchAll(/new\s+Signal(?:<[^>]*>)?\(\s*[^()]*,/g))
        notes.push(`${rel}:${lineOf(out, m.index ?? 0)} — new Signal(name, …): only the name is taken now; subscribe the handler with .subscribe()`);

    return { text: out, changes, notes };
}

/** Rewrites package.json: the dependency, the legacy signal package, and the scripts. */
export function migratePackageJson(text: string): { text: string; changes: number; notes: string[] } {
    const pkg = JSON.parse(text);
    const notes: string[] = [];
    let changes = 0;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = pkg[field];
        if (!deps) continue;
        if (deps[OLD_PKG] !== undefined) {
            const next: Record<string, string> = {};
            for (const [k, v] of Object.entries<string>(deps)) {
                if (k === OLD_PKG) next[NEW_PKG] = "^1.0.0";
                else next[k] = v;
            }
            pkg[field] = next;
            changes++;
        }
        if (pkg[field][OLD_SIGNAL] !== undefined) { delete pkg[field][OLD_SIGNAL]; changes++; }
    }
    const scripts: Record<string, string> = pkg.scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
        let next = cmd.replace(
            /node\s+-e\s+(['"])require\(\\?["']badmfck-api-server\\?["']\)\.(Deploy|Activate)\(\s*(?:\\?["']([^"'\\]*)\\?["'])?\s*\)\s*;?\s*\1/g,
            (_w, _q, fn: string, cfg?: string) => `bmfk ${fn.toLowerCase()}${cfg ? " " + cfg : ""}`);
        next = next.replace(/(^|[\s;&|(])badmfck(?=\s|$)/g, "$1bmfk");
        if (next !== cmd) { scripts[name] = next; changes++; }
        if (next.includes(OLD_PKG)) notes.push(`package.json scripts.${name} still mentions ${OLD_PKG}: "${next}" — change it by hand`);
    }
    const node = String(pkg.engines?.node ?? "");
    const major = Number(node.match(/(\d+)/)?.[1]);
    if (node && major < 24) notes.push(`package.json engines.node is "${node}" — ${NEW_PKG} needs Node.js 24 or later`);
    const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
    return { text: JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : ""), changes, notes };
}

// TypeScript is loaded from the project at run time (TypeScript 7, which builds this package, has no
// JavaScript API and no types for it), so its module and nodes are untyped here.
type TS = any;
type TSNode = any;

/**
 * The project's own TypeScript, used as the parser for validation models — or null when the project has
 * none, or one without the JavaScript API (TypeScript 7 has none).
 */
export function projectTypeScript(dir: string): TS | null {
    try {
        const ts = require(require.resolve("typescript", { paths: [dir] }));
        return typeof ts.createSourceFile === "function" ? ts : null;
    } catch { return null; }
}

const isIdentifier = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);

/**
 * Validation models: 6.x took a non-zero number sample as a bound (10 → at most 10, -5 → at least 5);
 * 1.0 takes it only as the type. Rewrites `amount: 10` into `amount: 0, $__amount_max: 10` (and -5 into
 * `$__x_min: 5`) in every object literal that is a model: the value of `validationModel`, a constant it
 * names in the same file, and any literal with `$__` keys. Fields that already have min/max are listed.
 */
export function migrateModels(text: string, rel: string, ts: TS): { text: string; changes: number; notes: string[] } {
    const kind = /\.(tsx|jsx)$/.test(rel) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
    const notes: string[] = [];
    const edits: { at: number; end: number; text: string }[] = [];
    const roots = new Set<TSNode>();
    const consts = new Map<string, TSNode>();
    const unwrap = (e: TSNode): TSNode => {
        while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e))) e = e.expression;
        return e;
    };
    const nameOf = (n: TSNode) => ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null;
    const named: string[] = [];

    const collect = (node: TSNode) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const init = unwrap(node.initializer);
            if (ts.isObjectLiteralExpression(init)) consts.set(node.name.text, init);
        }
        if (ts.isPropertyAssignment(node) && nameOf(node.name) === "validationModel") {
            const init = unwrap(node.initializer);
            if (ts.isObjectLiteralExpression(init)) roots.add(init);
            else if (ts.isIdentifier(init)) named.push(init.text);
        }
        if (ts.isObjectLiteralExpression(node) && node.properties.some((p: TSNode) => p.name && (nameOf(p.name) ?? "").startsWith("$__")))
            roots.add(node);
        ts.forEachChild(node, collect);
    };
    collect(sf);
    for (const n of named) { const o = consts.get(n); if (o) roots.add(o); }

    const seen = new Set<TSNode>();
    const walk = (obj: TSNode) => {
        if (seen.has(obj)) return;
        seen.add(obj);
        const keys = new Set(obj.properties.map((p: TSNode) => (p.name && nameOf(p.name)) ?? ""));
        // `$__X: { … }` counts as bounds only when it has min or max; a string `$__X` is just the description.
        const optionBounds = (key: string) => obj.properties.some((p: TSNode) => {
            if (!ts.isPropertyAssignment(p) || nameOf(p.name) !== `$__${key}`) return false;
            const o = unwrap(p.initializer);
            return ts.isObjectLiteralExpression(o) && o.properties.some((q: TSNode) => q.name && ["min", "max"].includes(nameOf(q.name) ?? ""));
        });
        for (const p of obj.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const key = nameOf(p.name);
            if (key === null || key.startsWith("$__")) continue;
            const init = unwrap(p.initializer);
            let value: number | null = null;
            if (ts.isNumericLiteral(init)) value = Number(init.text);
            else if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(init.operand)) value = -Number(init.operand.text);
            if (value !== null && value !== 0) {
                const line = sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1;
                if (keys.has(`$__${key}_min`) || keys.has(`$__${key}_max`) || optionBounds(key)) {
                    notes.push(`${rel}:${line} — "${key}: ${value}" also has min/max: 6.x applied both, 1.0 only min/max. Set the sample to 0 and check the bounds`);
                    continue;
                }
                const bound = `$__${key}_${value > 0 ? "max" : "min"}`;
                edits.push({ at: init.getStart(sf), end: init.getEnd(), text: "0" });
                edits.push({ at: p.getEnd(), end: p.getEnd(), text: `, ${isIdentifier(bound) ? bound : JSON.stringify(bound)}: ${Math.abs(value)}` });
            } else if (ts.isObjectLiteralExpression(init)) {
                walk(init);
            } else if (ts.isArrayLiteralExpression(init)) {
                for (const el of init.elements) { const e = unwrap(el); if (ts.isObjectLiteralExpression(e)) walk(e); }
            }
        }
    };
    for (const r of roots) walk(r);

    let out = text;
    for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
    return { text: out, changes: edits.length / 2, notes };
}

export function planMigration(dir: string, exported: Set<string>): IMigrationPlan {
    const plan: IMigrationPlan = { files: [], notes: [] };
    const ts = projectTypeScript(dir);
    if (!ts) plan.notes.push(`validation models were NOT checked: this needs TypeScript 5 in the project — run \`npm i -D typescript@5\` and migrate again (at startup the service also lists number samples that 6.x took as bounds)`);
    const pkgFile = path.join(dir, "package.json");
    if (fs.existsSync(pkgFile)) {
        const before = fs.readFileSync(pkgFile, "utf-8");
        const r = migratePackageJson(before);
        if (r.changes) plan.files.push({ file: pkgFile, before, after: r.text, changes: r.changes });
        plan.notes.push(...r.notes);
    }
    for (const file of sourceFiles(dir)) {
        const before = fs.readFileSync(file, "utf-8");
        const rel = path.relative(dir, file);
        let text = before, changes = 0;
        if (ts && /validationModel|\$__/.test(before)) {
            const m = migrateModels(text, rel, ts);
            text = m.text; changes += m.changes;
            plan.notes.push(...m.notes);
        }
        if (text.includes(OLD_PKG) || text.includes(OLD_SIGNAL) || /\bsecurityKey\s*:/.test(text)) {
            const r = migrateSource(text, rel, exported);
            text = r.text; changes += r.changes;
            plan.notes.push(...r.notes);
        }
        if (changes) plan.files.push({ file, before, after: text, changes });
    }
    return plan;
}

export async function MigrateProject(args: string[]): Promise<void> {
    const { red, green, yellow, dim, bold } = palette();
    const write = args.includes("--write");
    const dirs = args.filter(a => a !== "--write");
    if (dirs.length > 1) { console.error(red("✗ migrate takes one folder")); process.exit(1); }
    const dir = path.resolve(dirs[0] ?? ".");
    if (!fs.existsSync(path.join(dir, "package.json"))) {
        console.error(red(`✗ no package.json in ${dir} — run it in the project folder`));
        process.exit(1);
    }
    const index = [path.join(__dirname, "..", "..", "index.d.ts"), path.join(__dirname, "..", "..", "index.ts")].find(f => fs.existsSync(f));
    if (!index) { console.error(red("✗ can't find the package index to compare names against")); process.exit(1); }

    const plan = planMigration(dir, rootExportNames(index));
    console.log(bold(`\nbmfk migrate — ${dir}\n`));
    if (!plan.files.length) console.log(dim("  nothing to change"));
    for (const f of plan.files) console.log(`  ${write ? green("✓") : "•"} ${path.relative(dir, f.file)}  ${dim(`(${f.changes} change${f.changes > 1 ? "s" : ""})`)}`);
    if (plan.notes.length) {
        console.log(bold(yellow(`\nTo do by hand (${plan.notes.length}):`)));
        for (const n of plan.notes) console.log(`  ${yellow("!")} ${n}`);
    }
    console.log(bold("\nAlso check:"));
    console.log("  - MySQL values starting with \"_\" (host, user, database, password) were decrypted by 6.x; 1.0 uses them as written.");
    console.log("  - Services that call each other move to 1.0 together: 6.x and 1.0 can't call each other.");
    console.log("  - Deploy with a 1.0 deployer: copy setup.json, the project configs and <project>_state_.json into its folders.");
    console.log("  - Node.js 24 or later on the servers.");

    if (!write) {
        console.log(dim(`\nNothing written. Run again with --write to apply, then: npm install && npx tsc --noEmit\n`));
        return;
    }
    for (const f of plan.files) fs.writeFileSync(f.file, f.after, "utf-8");
    console.log(green(`\n✓ ${plan.files.length} file(s) written. Next: npm install && npx tsc --noEmit\n`));
}
