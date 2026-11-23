import fs from "fs";
import path from "path";
import os from "os";
import type * as esbuildTypes from "esbuild";
import type * as babelParser from "@babel/parser";

// `"bundle": true` in deploy.json: the app's own code (src/) goes into ONE file, every package from
// node_modules stays a plain require() — the server still runs `npm ci` and the packages load from
// node_modules exactly as without a bundle (@bmfk/api reads its html next to itself, native
// modules need their .node build — neither survives being glued in).
//
// The bundle lands where package.json "main" points (the file pm2 starts), inside a COPY of ./bin:
// the tsc output of every bundled module is left out, everything else in bin (html, json, workers)
// ships as it is. So the slot looks the same as without a bundle and __dirname in the entry file
// is still bin/. ./bin itself is never touched.
//
// esbuild and @babel/parser are optional peer dependencies: only a project that bundles needs them
// (`npm i -D esbuild @babel/parser`), so servers that install this package don't get them. Both are
// loaded here, on use — this module is imported by every app through Deploy.
export interface IBundleOptions {
    entry?: string,       // default: "main" mapped back from bin/ to src/ (bin/Main.js → src/Main.ts)
    sourcemap?: boolean,  // default true: <main>.map without sources, for `node --enable-source-maps`
    // Strip comments, rename locals and collapse whitespace. Free (no runtime cost) and makes the
    // shipped file hard to read, but string literals (so any baked-in value) stay in clear text —
    // it raises the bar against a casual read, it does not hide secrets. Default false.
    minify?: boolean,
}

export interface IBundleResult {
    stageDir: string,     // holds bin/ as it should be archived; the caller removes it
    outFile: string,      // e.g. "bin/Main.js"
    modules: number,      // source files in the bundle
    warnings: string[],
}

const SRC_EXT = /\.(c|m)?(t|j)sx?$/;

export async function Bundle(opt: boolean | IBundleOptions, pkg: any): Promise<IBundleResult> {
    const o: IBundleOptions = typeof opt === "object" && opt ? opt : {};

    if (!fs.existsSync("bin"))
        throw new Error("bundle: ./bin not found — bundle replaces the tsc output in ./bin, so the project must build there");

    const main = typeof pkg.main === "string" && pkg.main.length > 0 ? norm(pkg.main) : null;
    const entry = o.entry ? norm(o.entry) : guessEntry(main);
    if (!entry)
        throw new Error(`bundle: can't tell the entry file from package.json "main" (${main ?? "missing"}) — set "bundle": { "entry": "src/Main.ts" } in deploy.json`);
    if (!fs.existsSync(entry))
        throw new Error(`bundle: entry file not found: ${entry}`);

    const outFile = main ?? "bin/" + entry.replace(/^src\//, "").replace(SRC_EXT, ".js");
    if (!outFile.startsWith("bin/") || outFile.split("/").includes(".."))
        throw new Error(`bundle: package.json "main" must point inside ./bin (it is "${main}") — that is the file pm2 starts`);

    let esbuild: typeof esbuildTypes;
    let parse: typeof babelParser.parse;
    try { esbuild = require("esbuild"); parse = require("@babel/parser").parse; }
    catch (e: any) { throw new Error("bundle: install the bundler in this project — npm i -D esbuild @babel/parser (" + (e?.message ?? e) + ")"); }

    // write:false + outfile at its REAL place (./bin/Main.js): the sourcemap then points at ../src/…
    // just as tsc's would, and the files are written into the stage below instead.
    const result = await esbuild.build({
        entryPoints: [entry],
        outfile: path.resolve(outFile),
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        keepNames: true,                 // class/function .name stays as in the source, even minified
        minify: o.minify === true,
        sourcemap: o.sourcemap !== false,
        sourcesContent: false,           // the map only maps lines; the source code stays home
        metafile: true,
        write: false,
        logLevel: "warning",
    });

    const inputs = Object.keys(result.metafile!.inputs).map(norm).filter(f => !f.startsWith("node_modules/"));

    // tsc output of the bundled modules: src/a/B.ts → bin/a/B.js (+ .js.map, .d.ts, .d.ts.map)
    const dropped = new Set<string>();
    for (const f of inputs) {
        if (!f.startsWith("src/") || !SRC_EXT.test(f)) continue;
        const base = "bin/" + f.slice(4).replace(SRC_EXT, "");
        for (const ext of [".js", ".js.map", ".d.ts", ".d.ts.map"]) dropped.add(base + ext);
    }

    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "bmfk-bundle-"));
    try {
        fs.cpSync("bin", path.join(stageDir, "bin"), {
            recursive: true,
            filter: src => !dropped.has(norm(path.relative(process.cwd(), src))),
        });
        for (const file of result.outputFiles!) {
            const target = path.join(stageDir, path.relative(process.cwd(), file.path));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.contents);
        }

        const warnings = scanSources(inputs, entry, parse);

        // .js still in bin that is not the bundle: a worker or a dynamically required file (fine
        // unless it requires our modules — they now exist only inside the bundle), or leftovers of
        // deleted sources that tsc never cleans.
        const leftovers = listFiles(path.join(stageDir, "bin"))
            .map(f => "bin/" + norm(path.relative(path.join(stageDir, "bin"), f)))
            .filter(f => f.endsWith(".js") && f !== outFile);
        if (leftovers.length) {
            const shown = leftovers.slice(0, 10).join(", ") + (leftovers.length > 10 ? `, … (${leftovers.length} in all)` : "");
            warnings.push(`${leftovers.length} .js file(s) in ./bin are not in the bundle and ship as they are: ${shown} — `
                + `if one of them requires the project's own modules it will fail on the server (they exist only inside the bundle now)`);
        }

        return { stageDir, outFile, modules: inputs.length, warnings };
    } catch (e) {
        fs.rmSync(stageDir, { recursive: true, force: true });
        throw e;
    }
}

// bin/Main.js → src/Main.ts (or .tsx/.mts/.js) — the tsc layout rootDir=src, outDir=bin.
function guessEntry(main: string | null): string | null {
    if (!main || !main.startsWith("bin/")) return null;
    const base = "src/" + main.slice(4).replace(/\.(c|m)?js$/, "");
    for (const ext of [".ts", ".tsx", ".mts", ".js"])
        if (fs.existsSync(base + ext)) return base + ext;
    return null;
}

// What changes once the code lives in one file — warnings only, the deploy goes on:
//   - __dirname / __filename outside the entry: now the folder of the bundle (bin/), not of that file;
//   - a value imported from the entry (`export const __root = __dirname`) read while modules load,
//     not inside a function: the entry has not run yet. With tsc that is a silent undefined; in the
//     bundle it can also be a "Cannot access before initialization" crash.
// Parsed with @babel/parser, not the project's typescript: TypeScript 7 has no JS parser API.
function scanSources(files: string[], entry: string, parse: typeof babelParser.parse): string[] {
    const warnings: string[] = [];
    const entryBase = path.resolve(entry).replace(SRC_EXT, "");

    for (const file of files) {
        if (file === entry || !SRC_EXT.test(file) || file.endsWith(".d.ts")) continue;

        let ast: ReturnType<typeof babelParser.parse>;
        try {
            ast = parse(fs.readFileSync(file, "utf-8"), {
                sourceType: "module",
                plugins: ["typescript", "decorators-legacy", ...(file.endsWith("x") ? ["jsx" as const] : [])],
            });
        } catch (e: any) {
            warnings.push(`${file} — not checked, can't parse: ${e?.message ?? e}`);
            continue;
        }

        // Bindings imported from the entry file. Type-only imports are erased, they never run.
        const fromEntry = new Set<string>();
        for (const st of ast.program.body) {
            if (st.type !== "ImportDeclaration" || st.importKind === "type" || !st.source.value.startsWith(".")) continue;
            const target = path.resolve(path.dirname(path.resolve(file)), st.source.value);
            if (target.replace(SRC_EXT, "") !== entryBase && path.join(target, "index") !== entryBase) continue;
            for (const s of st.specifiers)
                if (s.type !== "ImportSpecifier" || s.importKind !== "type") fromEntry.add(s.local.name);
        }

        const reported = new Set<string>();
        const report = (msg: string) => { if (!reported.has(msg)) { reported.add(msg); warnings.push(msg); } };

        // loading = this code runs while the module is being imported (not deferred to a call).
        const visit = (node: any, loading: boolean): void => {
            if (!node || typeof node.type !== "string" || NOT_RUN.has(node.type)) return;

            if (node.type === "Identifier") {
                const line = node.loc?.start.line ?? 0;
                if (node.name === "__dirname" || node.name === "__filename")
                    report(`${file}:${line} — __dirname/__filename: in the bundle this is the folder of the bundle (bin/), not of ${file}`);
                else if (loading && fromEntry.has(node.name))
                    report(`${file}:${line} — "${node.name}" from ${entry} is read while modules load, before ${entry} has run: `
                        + `in the bundle that is undefined or a "Cannot access before initialization" crash — read it inside a function`);
                return;
            }

            // Bodies (and default parameters) of functions run when called; instance field
            // initializers run on `new`. Static fields and static blocks run while loading.
            if (FUNCTIONS.has(node.type) || (CLASS_FIELDS.has(node.type) && !node.static)) loading = false;

            for (const key of Object.keys(node)) {
                if (NOT_CODE_KEYS.has(key)) continue;
                // `x.__root`, `{ __root: 1 }`, `class { __root }` — a member name, not a read of the
                // binding. Shorthand `{ __root }` is still caught: its value is a separate Identifier.
                if (!node.computed && (key === "key" || (key === "property" && MEMBER_ACCESS.has(node.type))))
                    continue;
                const v = node[key];
                if (Array.isArray(v)) for (const c of v) visit(c, loading);
                else if (v && typeof v === "object") visit(v, loading);
            }
        };
        for (const st of ast.program.body) visit(st, true);
    }
    return warnings;
}

const NOT_RUN = new Set(["ImportDeclaration", "ExportSpecifier", "TSInterfaceDeclaration", "TSTypeAliasDeclaration",
    "TSDeclareFunction", "TSDeclareMethod", "TSTypeAnnotation"]);
const NOT_CODE_KEYS = new Set(["loc", "start", "end", "range", "extra", "leadingComments", "trailingComments", "innerComments",
    "typeAnnotation", "returnType", "typeParameters", "superTypeParameters", "typeArguments", "implements", "label"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const CLASS_FIELDS = new Set(["ClassProperty", "ClassPrivateProperty", "ClassAccessorProperty"]);
const MEMBER_ACCESS = new Set(["MemberExpression", "OptionalMemberExpression"]);

function listFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(full));
        else out.push(full);
    }
    return out;
}

function norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
