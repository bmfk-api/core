import { spawn, execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import { UID } from "../helper/UID";
import { ErrorUtils } from "../structures/DefaultErrors";
import { Http } from "../http/Http";
import os from "os";
import { Agent } from "undici";
import { resolveConfig, IDeployerConfig } from "./resolveConfig";
import { deployerHeaders, palette, stepLog, fmtSize } from "./cliCommon";
import { InterceptorSignedAuth } from "../interceptors/InterceptorSignedAuth";
import { Bundle, IBundleResult } from "./Bundler";

type IDeployerParams = IDeployerConfig;

export async function Deploy(opt?:IDeployerParams|string|null):Promise<string>{

    // Resolve config (deploy/ folder → deploy.json → explicit path/object). Shared with Activate.
    // resolveConfig() validates and returns a guaranteed-valid object, so no further checks here.
    opt = await resolveConfig(opt);

    const archiveName = UID.sha256(opt.name.replaceAll(".", "_")) + ".tar.gz";

    // Colors: ANSI escapes gated by TTY detection + NO_COLOR env (respects the standard convention).
    // Piped output (CI logs, redirect to file) stays clean plain text.
    const { red, green, yellow, dim, bold } = palette();
    const line = dim("─".repeat(60));
    const log = stepLog();

    console.log("");
    console.log(`${bold("▸ DEPLOY")} ${bold(opt.name)} ${dim("→")} ${opt.host}`);
    console.log(line);

    // change Config to live before upload
    // Regex is whitespace-tolerant: matches `scheme:Scheme=local`, `scheme : Scheme = local`,
    // `static scheme:Scheme = local`, `private readonly scheme: Scheme = local`, etc. Anchoring
    // with `:\s*Scheme\s*=` is what makes this specific (word "scheme" alone would hit random
    // identifiers/comments). `\blocal\b` prevents matching `localhost` or `local_dev`.
    const config = path.resolve("src", "Config.ts")
    // Optional step, like the "pattern not found" branch below: plenty of projects have no
    // src/Config.ts at all (SPA builds, different layouts). Missing file is not a deploy failure.
    if (!fs.existsSync(config)) {
        log.skip("config", "src/Config.ts not found — scheme switch skipped");
    } else {
        const configSrc = fs.readFileSync(config).toString("utf-8");
        const schemeRe = /(\bscheme\s*:\s*Scheme\s*=\s*)local\b/g;
        let replaced = 0;
        const updated = configSrc.replace(schemeRe, (_match, prefix) => {
            replaced++;
            return prefix + "live";
        });
        if (replaced > 0) {
            fs.writeFileSync(config, updated);
            log.ok("config", `switched to live (${replaced} occurrence${replaced === 1 ? "" : "s"})`);
        } else if (/\bscheme\s*:\s*Scheme\s*=\s*live\b/.test(configSrc)) {
            log.ok("config", "already live");
        } else {
            // Neither `= local` nor `= live` matched — file may have been renamed/restructured, or
            // the value is something unexpected (e.g. a variable reference). Warn loudly so the
            // deploy engineer can check, but don't abort — sometimes the field genuinely lives
            // elsewhere and this step is a no-op by design.
            log.warn("config", "no 'scheme: Scheme = local|live' pattern found in " + config +
                     " — check the file was not renamed/restructured");
        }
    }

    // Bump the patch version in package.json (the app can read it at runtime), unless the deploy
    // config says "versionBump": false — then the version is whatever package.json holds.
    const pkgPath = path.resolve("package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath).toString("utf-8"));
    const oldVersion = String(pkg.version || "0.0.0");
    const pkgName = String(pkg.name || opt.name);
    let newVersion = oldVersion;
    if (opt.versionBump !== false) {
        const parts = oldVersion.split(".").map(p => parseInt(p, 10) || 0);
        while (parts.length < 3) parts.push(0);
        parts[parts.length - 1] += 1;
        newVersion = parts.join(".");
        pkg.version = newVersion;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
        log.ok("version", `${oldVersion} ${dim("→")} ${bold(newVersion)}`);
    } else {
        log.ok("version", `${oldVersion} ${dim("(not bumped: versionBump false)")}`);
    }


    if (fs.existsSync(path.resolve(archiveName))) {
        fs.rmSync(path.resolve(archiveName));
    }

    // run npm build
    // The build's own output is shown only when it fails; what it wrote to stderr on a successful
    // run (warnings) is kept, under the step.
    const buildStep = log.start("build", "npm run build");
    const build = await exec("npm run build");
    if (build.code !== 0) {
        buildStep.fail(`npm run build failed (exit code ${build.code})`);
        const out = (build.stdout.trim() + "\n" + build.stderr.trim()).trim();
        if (out) console.error("\n" + out + "\n");
        process.exit(build.code);
    }
    buildStep.ok();
    for (const l of build.stderr.split(/\r?\n/)) if (l.trim()) log.note(l);

    // Build the tar item list.
    // Default base is `./bin` + `package.json` — the conventional layout of a TypeScript project
    // built into ./bin. If ./bin doesn't exist, we assume the project isn't following that
    // convention (e.g. static site, plain JS, custom build path) and skip BOTH defaults —
    // shipping package.json alone would be misleading.
    // Each entry is passed as a separate argv element to tar via execFileSync (no shell) — this
    // sidesteps shell injection and, importantly, means NO glob expansion: pass explicit paths
    // or directory names. Reject entries starting with `-` so a broken/malicious includes list
    // can't accidentally hand tar a flag.
    // `items` — файлы/каталоги относительно cwd. Идут в архив как есть.
    // `spaMode` — true, если ./dist с index.html обнаружен. В этом случае содержимое ./dist
    //   (всё, включая вложенные папки любой глубины) архивируется через `tar -C ./dist .` —
    //   попадёт в архив БЕЗ ведущего dist/, сервер развернёт прямо в корень слота.
    const items: string[] = [];
    let spaMode = false;
    const binExists = fs.existsSync("./bin");
    if (binExists) {
        // With a bundle, bin/ is archived from the bundle's stage instead (see below).
        if (!opt.bundle) items.push("./bin");
        if(fs.existsSync("package.json")){
            items.push("package.json");
        }

        // Ship package-lock.json quietly alongside package.json if it's present, so the server-side
        // `npm ci` can install exactly the locked versions. If the lockfile is missing, we don't
        // fabricate one — server will fall back to `npm i` (and warn about it).

        if (fs.existsSync("package-lock.json")) {
            items.push("package-lock.json");
        }

    } else if (fs.existsSync("./dist") && fs.existsSync(path.resolve("dist", "index.html"))) {
        // SPA/static-site fallback: no Node build in ./bin, but a built frontend in ./dist/
        // with an index.html — the typical Vite/webpack/CRA output layout. We archive the
        // ENTIRE contents of ./dist recursively (via `tar -C ./dist .` below), so on the
        // server they land straight at the slot root — nginx finds index.html at the top
        // level. package.json is intentionally skipped — SPA drops don't need it on the server.
        spaMode = true;
    }
    // `includes` entries are either a bare path (archived at that same path, the original
    // behaviour) or { src, dest } which places it anywhere inside the slot — typically inside
    // bin/. Entries that need relocating are COPIED INTO A TEMP STAGING DIR and archived from
    // there with a `-C <stage> .` group. We deliberately do NOT copy them into ./bin: tsc does
    // not clean ./bin, so foreign files would linger there and keep being shipped long after the
    // include was removed from the config.
    const staged: { src: string, dest: string }[] = [];
    if (Array.isArray(opt.includes)) {
        for (const raw of opt.includes) {
            const inc = typeof raw === "string" ? { src: raw, dest: raw } : raw;
            if (!inc || typeof inc.src !== "string" || inc.src.length === 0) continue;
            const src = inc.src;
            const dest = (inc.dest && inc.dest.length > 0 ? inc.dest : src).replace(/^\.\//, "");

            if (src.startsWith("-") || dest.startsWith("-"))
                throw new Error(`Include path must not start with '-': ${src} -> ${dest}`);
            // Missing includes used to be a warning, with tar failing later and less clearly.
            if (!fs.existsSync(src))
                throw new Error(`Include source does not exist: ${src}`);
            if (path.isAbsolute(dest) || dest.split(/[\\/]/).includes(".."))
                throw new Error(`Include 'dest' must be a relative path inside the slot, without '..': ${dest}`);

            // Same place it already lives → no copy needed, hand the path straight to tar.
            if (dest === src.replace(/^\.\//, "")) {
                items.push(src);
                continue;
            }
            staged.push({ src, dest });
        }
    }
    for (const s of staged) {
        const clash = items.some(i => i.replace(/^\.\//, "") === s.dest);
        if (clash) log.warn("include", `dest "${s.dest}" collides with an already-archived path — the later entry wins on extraction`);
    }
    // Nothing to archive: no ./bin, no ./dist, and no valid includes. Refuse — otherwise
    // we'd upload an empty (or near-empty) tarball and the server would deploy nothing,
    // likely misleading "success" on the operator's screen.
    if (items.length === 0 && !spaMode && staged.length === 0 && !opt.bundle) {
        throw new Error("Nothing to archive (no ./bin, no ./dist/index.html, no valid includes)");
    }

    // Collect exclude patterns from two sources:
    //   1. `.deployIgnore` in cwd — one pattern per line, `#` comments allowed, blank lines skipped
    //   2. `opt.excludes` array from the deploy config
    // Merge, dedupe, validate. Each pattern is passed to tar as `--exclude=<pattern>`. Tar accepts
    // standard shell globs here (`*.log`, `**/tmp`) — expansion is handled by tar internally,
    // NOT by shell (because we use execFileSync), so wildcards work but shell-metacharacters don't.
    const excludes = new Set<string>();
    const addExclude = (raw: unknown, source: string) => {
        if (typeof raw !== "string") return;
        const trimmed = raw.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) return;
        if (trimmed.startsWith("-")) {
            log.warn("exclude", `skipped, starts with '-' (from ${source}): ${trimmed}`);
            return;
        }
        excludes.add(trimmed);
    };

    // macOS litter, always excluded. "._*" are AppleDouble sidecars holding a file's extended
    // attributes: macOS creates them for real when a folder lives on a filesystem without native
    // xattr support (exFAT/FAT, SMB/AFP shares, some cloud-synced folders), and older macOS tar
    // also generated them while archiving. Either way they unpack on the server as junk next to
    // the real files ("._bin", "._package.json"). ".DS_Store" is the same class of noise.
    addExclude("._*", "built-in");
    addExclude(".DS_Store", "built-in");

    const ignoreFile = path.resolve(".deployignore");
    if (fs.existsSync(ignoreFile)) {
        const lines = fs.readFileSync(ignoreFile, "utf-8").split(/\r?\n/);
        for (const line of lines) addExclude(line, ".deployignore");
    }
    if (Array.isArray(opt.excludes)) {
        for (const ex of opt.excludes) addExclude(ex, "config.excludes");
    }

    // Tar honours --exclude flags placed before the file/dir list; keep that order.
    const excludeArgs = Array.from(excludes).map(p => `--exclude=${p}`);

    // Bundle: the app's code in one file at package.json "main", packages stay in node_modules
    // (server `npm ci` as usual). Built into a copy of bin/ — ./bin itself is never touched.
    let bundle: IBundleResult | null = null;
    if (opt.bundle) {
        const minified = typeof opt.bundle === "object" && opt.bundle.minify === true;
        const bundleStep = log.start("bundle", "bundling the project's code into one file");
        try { bundle = await Bundle(opt.bundle, pkg); }
        catch (e) { bundleStep.fail(); throw e; }
        bundleStep.ok(`${bundle.outFile} ${dim("·")} ${bundle.modules} source files` + (minified ? ` ${dim("·")} minified` : ""));
        for (const w of bundle.warnings) log.note(yellow("⚠ " + w));
    }

    // Build the full tar argv.
    // In SPA mode we archive the entire contents of ./dist recursively via `tar -C ./dist .` —
    // tar changes into dist and takes `.` (current dir), so paths end up at archive root without
    // the `dist/` prefix. If we also have cwd-relative items (from opt.includes), we reset with
    // a second `-C <cwd>` — `-C` applies to all subsequent items until the next `-C`.
    // tar supports mixing -C groups this way (both GNU tar and BSD tar).
    const tarArgs: string[] = ["-czf", archiveName, ...excludeArgs];
    if (spaMode) {
        tarArgs.push("-C", "./dist", ".");
        if (items.length > 0) {
            tarArgs.push("-C", process.cwd(), ...items);
        }
    } else {
        if (bundle) {
            tarArgs.push("-C", bundle.stageDir, "bin");
            if (items.length > 0) tarArgs.push("-C", process.cwd());
        }
        tarArgs.push(...items);
    }

    // Materialize relocated includes in a temp dir laid out exactly as the slot, then archive it
    // as one more `-C` group. Removed in the finally below, so nothing is left behind and ./bin
    // is never touched.
    let stageDir: string | null = null;
    const relocated: string[] = [];
    if (staged.length > 0) {
        stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "bmfk-deploy-"));
        for (const { src, dest } of staged) {
            const target = path.join(stageDir, dest);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.cpSync(path.resolve(src), target, { recursive: true });
            relocated.push(`${src} → ${dest}`);
        }
        tarArgs.push("-C", stageDir, ".");
    }

    // archive
    const archived = [
        ...(spaMode ? ["contents of ./dist (at archive root)"] : []),
        ...(bundle ? ["bin (bundle)"] : []),
        ...items.map(i => i.replace(/^\.\//, "")),
    ];
    const archiveStep = log.start("archive", archived.join(", "));
    try {
        // COPYFILE_DISABLE: on macOS the system tar (bsdtar via copyfile(3)) stores each file's
        // extended attributes — nowadays almost everything carries com.apple.provenance — as a
        // separate AppleDouble entry, which unpacks on the server as junk files named "._bin",
        // "._package.json", … This disables that. GNU tar on Linux ignores the variable, so it is
        // safe to always set.
        execFileSync("tar", tarArgs, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, COPYFILE_DISABLE: "1" },
        });
    } catch (err: any) {
        archiveStep.fail(`tar failed while creating ${archiveName}`);
        const out = (err.stdout || "").toString().trim();
        const errOut = (err.stderr || "").toString().trim();
        if (out) console.error(out);
        if (errOut) console.error(errOut);
        process.exit(typeof err.status === "number" ? err.status : 1);
    } finally {
        // Staging is pure scratch space — drop it whether tar succeeded or not.
        for (const dir of [stageDir, bundle?.stageDir]) {
            if (!dir) continue;
            try { fs.rmSync(dir, { recursive: true, force: true }); }
            catch (e: any) { console.warn(`Could not remove staging dir ${dir}: ${e?.message ?? e}`); }
        }
    }

    // check archive
    if (!fs.existsSync(path.resolve(archiveName))) {
        archiveStep.fail("archive was not created");
        return "";
    }
    const archiveSize = fmtSize(Math.max(1, Math.round(fs.statSync(path.resolve(archiveName)).size / 1024)));
    archiveStep.ok(`${countFiles(archiveName)} files ${dim("·")} ${archiveSize}`);
    log.note(archived.join(", "));
    for (const r of relocated) log.note("include: " + r);
    // The two built-in patterns are always there — only what the project itself excludes is news.
    const ownExcludes = Array.from(excludes).filter(e => e !== "._*" && e !== ".DS_Store");
    if (ownExcludes.length > 0) log.note("excluded: " + ownExcludes.join(", "));

    // Upload via Http.post(). Previously this route hung — undici.request() (the npm `undici`
    // package Http.ts imports) did a WebIDL brand-check on FormData tied to ITS OWN FormData
    // class, and choked on a FormData built from Node's global `new FormData()` (Node's built-in,
    // separately-vendored copy of undici) — a classic dual-package hazard. Symptom was a fully
    // established TCP+TLS connection with zero bytes ever written, timing out after ~60s.
    // Http.ts now detects any FormData-like body and re-wraps it into undici's own FormData
    // before calling request(), so the global FormData used below works correctly.
    const archivePath = path.resolve(archiveName);
    // With a privateKey the signature covers these fields and the archive's sha256: the server
    // deploys exactly this file for exactly this project, or nothing.
    const signedFields = { token: opt.token, name: opt.name };
    const uploadHeaders = deployerHeaders(opt, opt.host, signedFields,
        opt.privateKey ? { file: await InterceptorSignedAuth.sha256File(archivePath) } : undefined);
    const fileBlob = await fs.openAsBlob(archivePath);   // lazy-read Blob backed by the file
    const formData = new FormData();
    formData.set("token", opt.token);
    formData.set("name", opt.name);
    formData.set("file", fileBlob, archiveName);         // 3rd arg = filename for Content-Disposition

    // The server answers only after it has unpacked, installed and restarted — the wait is mostly that.
    const uploadStep = log.start("upload", `${archiveSize} ${dim("·")} the server unpacks, installs and restarts`);
    const startedAt = Date.now();

    // Custom undici Agent with generous timeouts — the server-side deployer runs
    // `npm ci`, unpack, PM2 restart, nginx reload SYNCHRONOUSLY before responding,
    // which can exceed default 60s headersTimeout on big projects.
    const uploadAgent = new Agent({
        headersTimeout: 5 * 60 * 1000,
        bodyTimeout: 5 * 60 * 1000,
    });

    const uploadResponse = await Http.post(opt.host, formData, {
        headers: uploadHeaders,
        dispatcher: uploadAgent,
        timeoutMs: 5 * 60 * 1000,                        // 5 min — big archives + slow links
        retry: { enabled: false },                       // belt & suspenders — Http.ts also forces
                                                           // this off automatically for multipart bodies
    });
    const elapsedMs = Date.now() - startedAt;
    if (uploadResponse.ok) uploadStep.ok(`${archiveSize} sent, server answered`);
    else uploadStep.fail("no successful answer from the server");

    // ---- Response analysis ----

    const deployedAt = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${deployedAt.getFullYear()}-${pad(deployedAt.getMonth() + 1)}-${pad(deployedAt.getDate())} ${pad(deployedAt.getHours())}:${pad(deployedAt.getMinutes())}:${pad(deployedAt.getSeconds())}`;

    console.log(""); // spacer

    // Stage 1 — transport layer: network reached the server and got a 2xx?
    if (!uploadResponse.ok) {
        const statusStr = uploadResponse.status !== undefined
            ? `HTTP ${uploadResponse.status}`
            : "network error (no response)";
        console.error(red(bold("✗ DEPLOY FAILED — transport error")));
        console.error(line);
        console.error(`  ${dim("host:    ")} ${opt.host}`);
        console.error(`  ${dim("status:  ")} ${statusStr}`);
        console.error(`  ${dim("elapsed: ")} ${elapsedMs}ms`);
        if (uploadResponse.error !== undefined) {
            const errText = typeof uploadResponse.error === "string"
                ? uploadResponse.error
                : JSON.stringify(uploadResponse.error);
            const clipped = errText.length > 400 ? errText.slice(0, 400) + `... (${errText.length} total)` : errText;
            console.error(`  ${dim("error:   ")} ${clipped}`);
        }
        console.error(line);
        process.exit(1);
    }

    // Stage 2 — application layer: server returned 2xx, but body may still be an IError.
    // Response shape from Deployer.file: `{data: <proceed_result>}` where proceed_result is
    // itself either `{data: true}` on success or `{error: {code,message,...}}` on rejection.
    // So we may find the error one or two levels deep; check every plausible position.
    const body: any = uploadResponse.data;
    let appError: any = null;
    if (body && typeof body === "object") {
        if (ErrorUtils.isError(body?.error))       appError = body.error;
        else if (ErrorUtils.isError(body?.data?.error)) appError = body.data.error;
        else if (ErrorUtils.isError(body?.data))   appError = body.data;
        else if (ErrorUtils.isError(body))         appError = body;
    }

    if (appError) {
        console.error(red(bold("✗ DEPLOY REJECTED BY SERVER")));
        console.error(line);
        console.error(`  ${dim("host:     ")} ${opt.host}`);
        console.error(`  ${dim("code:     ")} ${appError.code}`);
        console.error(`  ${dim("message:  ")} ${appError.message}`);
        if (appError.httpStatus) console.error(`  ${dim("httpCode: ")} ${appError.httpStatus}`);
        if (appError.details !== undefined) {
            const d = typeof appError.details === "string" ? appError.details : JSON.stringify(appError.details);
            const clipped = d.length > 400 ? d.slice(0, 400) + `... (${d.length} total)` : d;
            console.error(`  ${dim("details:  ")} ${clipped}`);
        }
        console.error(`  ${dim("elapsed:  ")} ${elapsedMs}ms`);
        console.error(line);
        process.exit(1);
    }

    // Stage 3 — success. Note: we can't 100% prove "successful deploy" from HTTP layer alone
    // (server could return 2xx with empty body). If body is null/empty we still call it OK but
    // log yellow warning so operator eyeballs the server side just in case.
    const emptyResponse = body === null || body === undefined
        || (typeof body === "object" && Object.keys(body).length === 0);

    // Project under review: the archive is held on the deployer, production is untouched.
    const pending: any = body?.data?.data;
    if (pending && typeof pending === "object" && pending.pendingReview === true) {
        console.log(yellow(bold("⏳ UPLOADED — WAITING FOR REVIEW (not deployed yet)")));
        console.log(line);
        console.log(`  ${dim("project:  ")} ${opt.name}`);
        console.log(`  ${dim("version:  ")} ${oldVersion} ${dim("→")} ${bold(newVersion)}`);
        console.log(`  ${dim("reviewers:")} ${(pending.reviewers ?? []).join(", ")} ${dim(pending.mode === "all" ? "(all must accept)" : "(any one can accept)")}`);
        if (Array.isArray(pending.notNotified) && pending.notNotified.length)
            console.log(`  ${yellow("⚠ email not delivered to:")} ${pending.notNotified.join(", ")}`);
        if (pending.expiresAt)
            console.log(`  ${dim("link valid until:")} ${new Date(pending.expiresAt).toISOString()}`);
        if (pending.replacedPrevious)
            console.log(`  ${dim("replaced the previous pending upload — its links no longer work")}`);
        console.log(`  ${dim("elapsed:  ")} ${elapsedMs}ms`);
        console.log(line);
        console.log("");
        return archiveName;
    }

    if (emptyResponse) {
        console.log(yellow(bold("⚠ DEPLOY LIKELY OK (server returned empty response)")));
    } else {
        console.log(green(bold("✓ DEPLOY SUCCESSFUL")));
    }
    console.log(line);
    console.log(`  ${dim("project: ")} ${opt.name}`);
    console.log(`  ${dim("package: ")} ${pkgName}`);
    console.log(`  ${dim("version: ")} ${oldVersion} ${dim("→")} ${bold(newVersion)}`);
    console.log(`  ${dim("archive: ")} ${archiveName}`);
    console.log(`  ${dim("host:    ")} ${opt.host}`);
    console.log(`  ${dim("status:  ")} HTTP ${uploadResponse.status}`);
    console.log(`  ${dim("elapsed: ")} ${elapsedMs}ms`);
    console.log(`  ${dim("time:    ")} ${stamp}`);

    // Server-reported deploy info. `body.data.data` is proceed()'s actual return value —
    // double-wrapped because Deployer.file returns `{data: <REQ_DEPLOYMENT_PROCEED result>}`,
    // and proceed() itself returns `{data: {ok, project, bluegreen, slot, active, activeThisDeploy}}`.
    // Real shape (auth-ok, non-B/G project):
    //   {"data":{"data":{"ok":true,"project":"...","bluegreen":false,"slot":null,"active":null,"activeThisDeploy":true}},...}
    // Only show this block if the server actually reports it — older server versions returned a
    // bare `{data: true}`, which gracefully degrades to "no info block shown" here.
    const info: any = body?.data?.data;
    if (info && typeof info === "object" && "ok" in info) {
        // Server's own project identifier — usually equals opt.name, but could diverge
        // (e.g. a future server-side rename/suffix scheme), so surface it if different.
        if (info.project && info.project !== opt.name) {
            console.log(`  ${dim("server project:")} ${info.project}`);
        }
        if (info.bluegreen === true) {
            const slotBadge = info.activeThisDeploy
                ? green("← active in production")
                : yellow("(inactive — deploy landed but nginx still points at " + info.active + "; run /pckg/switch to promote)");
            console.log(`  ${dim("mode:    ")} blue-green`);
            console.log(`  ${dim("slot:    ")} ${bold(String(info.slot))} ${slotBadge}`);
            if (info.active && info.active !== info.slot) {
                console.log(`  ${dim("active:  ")} ${info.active}`);
            }
        } else if (info.bluegreen === false) {
            console.log(`  ${dim("mode:    ")} single-instance ${green("← active")}`);
        }
    }

    if (!emptyResponse) {
        // Show the server's payload compact-JSON'd, capped so we don't spam the console for large replies.
        const payload = JSON.stringify(body);
        const clipped = payload.length > 300 ? payload.slice(0, 300) + `... (${payload.length} total)` : payload;
        console.log(`  ${dim("response:")} ${clipped}`);
    }
    console.log(line);
    console.log("");

    return archiveName;
}



// Runs a shell command without blocking the event loop (the spinner keeps turning), output captured.
function exec(cmd: string): Promise<{ code: number, stdout: string, stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(cmd, { shell: true });
        let stdout = "", stderr = "";
        child.stdout.on("data", d => stdout += d);
        child.stderr.on("data", d => stderr += d);
        child.on("error", e => resolve({ code: 1, stdout, stderr: stderr + String(e?.message ?? e) }));
        child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

// Files in the archive, directories not counted. "?" if tar can't list it — it is only a number to show.
function countFiles(archive: string): number | string {
    try {
        return execFileSync("tar", ["-tzf", archive], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 })
            .split("\n").filter(l => l.length > 0 && !l.endsWith("/")).length;
    } catch { return "?"; }
}
