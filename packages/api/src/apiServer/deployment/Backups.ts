import { Http } from "../http/Http";
import { resolveConfig, IDeployerConfig } from "./resolveConfig";
import { deployerUrl, deployerHeaders, responseError, palette, fmtDate, fmtSize } from "./cliCommon";

/** Prints the project's deploy backups (pckg/backups). Returns the list; exits 1 on failure. */
export async function Backups(opt?: IDeployerConfig | string | null): Promise<any[]> {
    opt = await resolveConfig(opt);
    const { red, yellow, blue, green, dim, bold } = palette();

    const url = deployerUrl(opt, "backups"), body = { name: opt.name };
    const r = await Http.post(url, body, {
        headers: deployerHeaders(opt, url, body), timeoutMs: 30000, retry: { enabled: false },
    });
    const err = responseError(r);
    if (err) {
        console.error(red(bold("✗ Cannot list backups: ")) + err);
        process.exit(1);
    }

    const info: any = (r as any).data?.data ?? {};
    const list: any[] = info.backups ?? [];
    const slotColor = (s: string | null) => s === "blue" ? blue(s) : s === "green" ? green(s) : dim("—");
    const line = dim("─".repeat(72));

    console.log("");
    console.log(`${bold("●")} ${bold(info.project ?? opt.name)}   ${dim("backups:")} ${list.length}/${info.keep ?? "?"}` +
        (info.bluegreen ? `   ${dim("active:")} ${slotColor(info.activeSlot)}` : ""));
    if (!info.backupEnabled)
        console.log(yellow("  ⚠ backup is disabled for this project — new deploys are not backed up"));
    console.log(line);
    if (list.length === 0) {
        console.log(dim("  no backups yet"));
    } else {
        for (const b of list) {
            const reason = b.reason === "pre-restore" ? yellow("pre-restore") : dim("deploy     ");
            console.log(`  ${bold(b.name)}`);
            console.log(`      ${dim("ver")} ${String(b.appVersion ?? "?").padEnd(12)}` +
                (info.bluegreen ? `${dim("slot")} ${slotColor(b.slot).padEnd(15)}` : "") +
                `${reason}  ${dim("by")} ${b.user}  ${dim(fmtDate(b.createdAt))}  ${dim(fmtSize(b.sizeKb))}`);
        }
    }
    console.log(line);
    console.log("");
    return list;
}
