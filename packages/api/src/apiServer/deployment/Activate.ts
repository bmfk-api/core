import { Http } from "../http/Http";
import { ErrorUtils } from "../structures/DefaultErrors";
import { resolveConfig, IDeployerConfig } from "./resolveConfig";
import { deployerHeaders } from "./cliCommon";

type IActivateParams = IDeployerConfig;

/**
 * Activates a blue-green slot on the deployer server.
 *
 * @param opt   IActivateParams inline OR path to a JSON config file (same shape as Deploy).
 * @param scheme  Optional explicit slot to activate:
 *                  - "blue" / "green": activate that specific slot (allows rollback);
 *                  - omitted: server activates `lastDeployed` (normal forward switch after Deploy).
 *
 * Response shape from server (`/pckg/switch`):
 *   { data: { active, previousActive, action: "switch"|"rollback", hookError: string|null } }
 *
 * Returns the newly-active slot name ("blue"|"green"). Calls process.exit(1) on any failure.
 */
export async function Activate(opt?: IActivateParams | string | null, scheme?: "blue" | "green"): Promise<string> {

    // Resolve config the same way Deploy does: deploy/ folder → deploy.json → explicit path/object.
    opt = await resolveConfig(opt);

    if (scheme && scheme !== "blue" && scheme !== "green") {
        throw new Error(`Invalid scheme: ${scheme}. Must be "blue" or "green" (or omitted).`);
    }

    // Derive switch URL: explicit override wins, otherwise swap `/add` → `/switch` on `host`.
    // If neither matches, refuse — we don't want to POST switch to a random /add-looking endpoint.
    let switchUrl: string;
    if (opt.switch_host) {
        switchUrl = opt.switch_host;
    } else if (/\/add\/?$/.test(opt.host)) {
        switchUrl = opt.host.replace(/\/add\/?$/, "/switch");
    } else {
        throw new Error(
            `Cannot derive switch URL from host "${opt.host}". ` +
            `Either add "switch_host" to config, or make sure "host" ends with /add.`
        );
    }


    // JSON body. `scheme` is only included if the caller explicitly passed one — server-side
    // validator treats it as optional and defaults to `state.lastDeployed`. Passing an empty
    // string would fail validation (not in enum ["blue","green"]).
    const requestBody: Record<string, string> = { name: opt.name, token: opt.token };
    if (scheme) requestBody.scheme = scheme;

    console.log(`Activating${scheme ? ` slot=${scheme}` : " (auto: lastDeployed)"} for ${opt.name} at ${switchUrl}`);
    const startedAt = Date.now();
    const response = await Http.post(switchUrl, requestBody, {
        headers: deployerHeaders(opt, switchUrl, requestBody),
        timeoutMs: 60 * 1000,               // switch is fast (nginx reload ~sub-sec) but be generous
        retry: { enabled: false },          // never retry a switch — state has been flipped by then
    });
    const elapsedMs = Date.now() - startedAt;

    // ---- Response analysis ----
    // Same 3-stage pattern as Deploy: transport → application error → success.
    // Colors gated by TTY + NO_COLOR env — piped output stays plain.
    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const c = (code: string, t: string) => useColor ? `\x1b[${code}m${t}\x1b[0m` : t;
    const red = (t: string) => c("31", t);
    const green = (t: string) => c("32", t);
    const yellow = (t: string) => c("33", t);
    const dim = (t: string) => c("2", t);
    const bold = (t: string) => c("1", t);
    const line = dim("─".repeat(60));

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    console.log("");

    // Stage 1 — transport: did we get a 2xx from the server?
    if (!response.ok) {
        const statusStr = response.status !== undefined
            ? `HTTP ${response.status}`
            : "network error (no response)";
        console.error(red(bold("✗ ACTIVATE FAILED — transport error")));
        console.error(line);
        console.error(`  ${dim("host:    ")} ${switchUrl}`);
        console.error(`  ${dim("status:  ")} ${statusStr}`);
        console.error(`  ${dim("elapsed: ")} ${elapsedMs}ms`);
        if (response.error !== undefined) {
            const errText = typeof response.error === "string"
                ? response.error
                : JSON.stringify(response.error);
            const clipped = errText.length > 400 ? errText.slice(0, 400) + `... (${errText.length} total)` : errText;
            console.error(`  ${dim("error:   ")} ${clipped}`);
        }
        console.error(line);
        process.exit(1);
    }

    // Stage 2 — application: 2xx but body might contain IError. Deployer.switchSlot is
    // pass-through (unlike deploy which double-wraps), so error is one level up — but we
    // still check nested positions defensively for future-proofness.
    const body: any = response.data;
    let appError: any = null;
    if (body && typeof body === "object") {
        if (ErrorUtils.isError(body?.error))       appError = body.error;
        else if (ErrorUtils.isError(body?.data?.error)) appError = body.data.error;
        else if (ErrorUtils.isError(body?.data))   appError = body.data;
        else if (ErrorUtils.isError(body))         appError = body;
    }
    if (appError) {
        console.error(red(bold("✗ ACTIVATE REJECTED BY SERVER")));
        console.error(line);
        console.error(`  ${dim("host:     ")} ${switchUrl}`);
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

    // Stage 3 — success. Server payload: { active, previousActive, action, hookError }.
    // Note: hookError !== null means state+symlink DID flip, only nginx reload failed —
    // the switch happened, operator just needs to retry the reload manually. Yellow ⚠, not red ✗.
    const info: any = body?.data ?? {};
    const action = info.action ?? "switch";
    const active = info.active ?? "?";
    const previous = info.previousActive ?? "?";
    const hookError: string | null = info.hookError ?? null;

    if (hookError) {
        console.log(yellow(bold("⚠ SLOT FLIPPED BUT nginx RELOAD FAILED")));
    } else if (action === "rollback") {
        console.log(green(bold("✓ ROLLBACK SUCCESSFUL")));
    } else {
        console.log(green(bold("✓ ACTIVATE SUCCESSFUL")));
    }
    console.log(line);
    console.log(`  ${dim("project:  ")} ${opt.name}`);
    console.log(`  ${dim("action:   ")} ${action}`);
    console.log(`  ${dim("active:   ")} ${previous} ${dim("→")} ${bold(active)}`);
    console.log(`  ${dim("host:     ")} ${switchUrl}`);
    console.log(`  ${dim("status:   ")} HTTP ${response.status}`);
    console.log(`  ${dim("elapsed:  ")} ${elapsedMs}ms`);
    console.log(`  ${dim("time:     ")} ${stamp}`);
    if (hookError) {
        console.log(`  ${dim("hookErr:  ")} ${yellow(hookError)}`);
        console.log(dim(`  (state + symlink already committed; retry the reload manually: nginx -s reload)`));
    }
    console.log(line);
    console.log("");

    return active;
}
