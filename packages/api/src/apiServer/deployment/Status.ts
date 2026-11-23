import { Http } from "../http/Http";
import { ErrorUtils } from "../structures/DefaultErrors";
import { resolveConfig, IDeployerConfig } from "./resolveConfig";
import { deployerHeaders } from "./cliCommon";

/**
 * Prints the blue-green state of a project as the deployer sees it (pckg/status):
 * which slot is live, which was deployed last, and whether a deployed slot awaits activation.
 *
 * @param opt  IDeployerConfig inline OR path to a JSON config (same as Deploy/Activate);
 *             omitted → auto-discovery (deploy/ folder → deploy.json).
 * Returns the active slot ("blue"|"green") or null. Calls process.exit(1) on failure.
 */
export async function Status(opt?: IDeployerConfig | string | null): Promise<string | null> {
    opt = await resolveConfig(opt);

    // Same derivation rule as Activate: swap the trailing /add (or /switch of switch_host) for /status.
    let statusUrl: string;
    if (/\/add\/?$/.test(opt.host)) statusUrl = opt.host.replace(/\/add\/?$/, "/status");
    else if (opt.switch_host && /\/switch\/?$/.test(opt.switch_host)) statusUrl = opt.switch_host.replace(/\/switch\/?$/, "/status");
    else throw new Error(`Cannot derive status URL from host "${opt.host}" — make sure "host" ends with /add.`);

    const requestBody = { name: opt.name };
    const response = await Http.post(statusUrl, requestBody, {
        headers: deployerHeaders(opt, statusUrl, requestBody),
        timeoutMs: 15 * 1000,
        retry: { enabled: false },
    });

    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const c = (code: string, t: string) => useColor ? `\x1b[${code}m${t}\x1b[0m` : t;
    const red = (t: string) => c("31", t), green = (t: string) => c("32", t), yellow = (t: string) => c("33", t);
    const blue = (t: string) => c("34", t), dim = (t: string) => c("2", t), bold = (t: string) => c("1", t);
    const slotColor = (s: string | null | undefined) => s === "blue" ? blue(bold("BLUE")) : s === "green" ? green(bold("GREEN")) : dim("—");
    const line = dim("─".repeat(60));

    console.log("");
    if (!response.ok) {
        console.error(red(bold("✗ STATUS FAILED — transport error")));
        console.error(line);
        console.error(`  ${dim("host:  ")} ${statusUrl}`);
        console.error(`  ${dim("status:")} ${response.status !== undefined ? `HTTP ${response.status}` : "network error (no response)"}`);
        if (response.error !== undefined) {
            const t = typeof response.error === "string" ? response.error : JSON.stringify(response.error);
            console.error(`  ${dim("error: ")} ${t.length > 400 ? t.slice(0, 400) + "…" : t}`);
        }
        console.error(line);
        process.exit(1);
    }

    const body: any = response.data;
    const appError = ErrorUtils.isError(body?.error) ? body.error : ErrorUtils.isError(body?.data) ? body.data : null;
    if (appError) {
        console.error(red(bold("✗ STATUS REJECTED BY SERVER")));
        console.error(line);
        console.error(`  ${dim("code:   ")} ${appError.code}`);
        console.error(`  ${dim("message:")} ${appError.message}`);
        console.error(line);
        process.exit(1);
    }

    const entry = body?.data?.[opt.name];
    if (!entry) {
        console.error(red(bold(`✗ Project "${opt.name}" is not configured on the deployer`)));
        process.exit(1);
    }

    const state = entry.state;
    console.log(`${bold("●")} ${bold(opt.name)}`);
    console.log(line);
    if (!entry.hasBlueGreen) {
        console.log(`  ${dim("mode:        ")} single slot ${dim("(no blue-green configured)")}`);
    } else if (!state) {
        console.log(`  ${dim("mode:        ")} blue-green`);
        console.log(`  ${dim("state:       ")} ${yellow("never deployed")}`);
    } else {
        console.log(`  ${dim("active:      ")} ${slotColor(state.active)}`);
        console.log(`  ${dim("lastDeployed:")} ${slotColor(state.lastDeployed)}`);
        if (entry.readyToSwitch)
            console.log(`  ${yellow("⚠ " + state.lastDeployed + " is deployed but NOT switched")} ${dim("→ bmfk activate")}`);
        const last = Array.isArray(state.history) && state.history.length ? state.history[state.history.length - 1] : null;
        if (last) {
            const d = new Date(last.at);
            const pad = (n: number) => String(n).padStart(2, "0");
            const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            console.log(`  ${dim("last action: ")} ${last.action} ${last.slot} ${dim("by")} ${last.user} ${dim("·")} ${when}`);
        }
    }
    console.log(line);
    console.log("");

    return state?.active ?? null;
}
