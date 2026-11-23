import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { palette } from "./cliCommon";

// Prompts for the interactive CLI commands. A readline per visible question: the hidden prompts
// (askHidden) switch the terminal to raw mode and must not share it with an open readline.

export async function ask(question: string, def = ""): Promise<string> {
    const { dim } = palette();
    const rl = createInterface({ input, output });
    try {
        const a = (await rl.question(question + (def ? dim(` [${def}]`) : "") + ": ")).trim();
        return a || def;
    } finally { rl.close(); }
}

export async function askValid(question: string, def: string, check: (v: string) => string | null): Promise<string> {
    const { red } = palette();
    for (;;) {
        const v = await ask(question, def);
        const problem = check(v);
        if (!problem) return v;
        console.log(red(`  ✗ ${problem}`));
    }
}

export async function yes(question: string, def: boolean): Promise<boolean> {
    const a = (await ask(question + " (y/n)", def ? "y" : "n")).toLowerCase();
    return a.startsWith("y");
}

export const list = (v: string, sep = ",") => v.split(sep).map(s => s.trim()).filter(Boolean);

// Shell-like split: quoted parts keep their spaces — `--cron-restart "10 0 * * *"` is two tokens.
export const tokens = (v: string) => Array.from(v.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), m => m[1] ?? m[2] ?? m[3]);
