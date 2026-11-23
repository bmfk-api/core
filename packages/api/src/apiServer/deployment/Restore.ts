import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { Http } from "../http/Http";
import { resolveConfig, IDeployerConfig } from "./resolveConfig";
import { deployerUrl, deployerHeaders, responseError, palette, fmtDate } from "./cliCommon";

/**
 * Restores a deploy backup (pckg/restore).
 *   backupName omitted → interactive pick from the list (TTY only).
 *   Asks for confirmation in a TTY; non-interactively it requires assumeYes (--yes), because
 *   restoring an active slot or a regular project changes production at once.
 */
export async function Restore(opt?: IDeployerConfig | string | null, backupName?: string, assumeYes = false): Promise<void> {
    opt = await resolveConfig(opt);
    const { red, yellow, green, dim, bold } = palette();
    const fail = (msg: string): never => { console.error(red(bold("✗ ")) + msg); process.exit(1); };

    // The list tells us the backup's slot and which slot is active — needed for the LIVE warning.
    const listUrl = deployerUrl(opt, "backups"), listBody = { name: opt.name };
    const lr = await Http.post(listUrl, listBody, { headers: deployerHeaders(opt, listUrl, listBody), timeoutMs: 30000, retry: { enabled: false } });
    const lerr = responseError(lr);
    if (lerr) fail("Cannot list backups: " + lerr);
    const info: any = (lr as any).data?.data ?? {};
    const list: any[] = info.backups ?? [];
    if (list.length === 0) fail(`No backups for "${opt.name}".`);

    const rl = input.isTTY ? createInterface({ input, output }) : null;
    let chosen: any;
    try {
        if (backupName) {
            chosen = list.find(b => b.name === backupName);
            if (!chosen) fail(`Backup "${backupName}" not found. Run \`bmfk backups\` to see the list.`);
        } else {
            if (!rl) fail("Backup name is required when not running in a terminal: bmfk restore <backup-name> --yes");
            console.log("");
            list.forEach((b, i) => console.log(`  [${i + 1}] ${b.name}  ${dim("ver")} ${b.appVersion ?? "?"}  ${dim(fmtDate(b.createdAt))}`));
            while (!chosen) {
                const a = await rl!.question(`\nRestore which backup [1-${list.length}]: `);
                const i = parseInt(a.trim(), 10) - 1;
                if (i >= 0 && i < list.length) chosen = list[i];
                else console.error(`Enter a number from 1 to ${list.length}.`);
            }
        }

        const live = !info.bluegreen || chosen.slot === info.activeSlot;
        console.log("");
        console.log(`${bold("Restore")} ${bold(opt.name)} ${dim("←")} ${chosen.name} ${dim("(ver " + (chosen.appVersion ?? "?") + ")")}`);
        if (info.bluegreen) console.log(`  ${dim("slot:")} ${chosen.slot}   ${dim("active:")} ${info.activeSlot ?? "?"}`);
        console.log(live
            ? yellow(bold("  ⚠ LIVE: production traffic gets the restored code immediately"))
            : dim(`  not live — the slot will need: bmfk activate ${chosen.slot}`));
        console.log(dim("  current contents are backed up first, so this can be undone"));

        if (!assumeYes) {
            if (!rl) fail("Refusing to restore non-interactively without --yes.");
            const a = await rl!.question("\nProceed? [y/N] ");
            if (!/^y(es)?$/i.test(a.trim())) { console.log("Cancelled."); return; }
        }
    } finally {
        rl?.close();
    }

    // A full copy of node_modules can take a while, so the timeout is generous.
    console.log(dim("\nRestoring…"));
    const restoreUrl = deployerUrl(opt, "restore"), restoreBody = { name: opt.name, token: opt.token, backup: chosen.name };
    const rr = await Http.post(restoreUrl, restoreBody,
        { headers: deployerHeaders(opt, restoreUrl, restoreBody), timeoutMs: 10 * 60 * 1000, retry: { enabled: false } });
    const rerr = responseError(rr);
    if (rerr) fail("Restore failed: " + rerr);

    const d: any = (rr as any).data?.data ?? {};
    const line = dim("─".repeat(60));
    console.log("");
    console.log(d.pm2Error ? yellow(bold("⚠ RESTORED, BUT pm2 RESTART FAILED")) : green(bold("✓ RESTORED")));
    console.log(line);
    console.log(`  ${dim("project:    ")} ${d.project}`);
    console.log(`  ${dim("backup:     ")} ${d.restored}  ${dim("(ver " + (d.appVersion ?? "?") + ")")}`);
    if (d.slot) console.log(`  ${dim("slot:       ")} ${d.slot}   ${dim("active:")} ${d.activeSlot ?? "?"}`);
    console.log(`  ${dim("live:       ")} ${d.live ? bold("yes") : "no"}`);
    console.log(`  ${dim("pm2:        ")} ${d.pm2Error ? yellow(d.pm2Error) : d.pm2Restarted ? "restarted" : "not used"}`);
    if (d.preRestoreBackup)
        console.log(`  ${dim("undo with:  ")} bmfk restore ${d.preRestoreBackup}`);
    if (!d.live && d.slot)
        console.log(`  ${dim("next:       ")} bmfk activate ${d.slot}`);
    console.log(line);
    console.log("");
}
