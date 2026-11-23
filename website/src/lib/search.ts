import GithubSlugger from "github-slugger";
import { docs, rawDoc } from "../docs/nav";
import { replaceTokens } from "./remarkSiteTokens";

export interface SearchSection { slug: string, page: string, heading: string, anchor: string, text: string }

// One entry per heading of every page, built from the MDX source. Anchors are made the way
// rehype-slug makes the heading ids, so a result lands on the right heading.
function build(): SearchSection[] {
  const out: SearchSection[] = [];
  for (const d of docs) {
    const slugger = new GithubSlugger();
    let current: SearchSection = { slug: d.slug, page: d.title, heading: d.title, anchor: "", text: d.description };
    let inCode = false;
    for (const line of replaceTokens(rawDoc(d.slug)).split("\n")) {
      if (line.startsWith("```")) { inCode = !inCode; continue; }
      const h = !inCode && /^(#{2,3})\s+(.*)$/.exec(line);
      if (h) {
        out.push(current);
        const heading = plain(h[2]);
        current = { slug: d.slug, page: d.title, heading, anchor: slugger.slug(heading), text: "" };
        continue;
      }
      if (/^(import|export) /.test(line)) continue;
      current.text += " " + (inCode ? line : plain(line));
    }
    out.push(current);
  }
  return out;
}

function plain(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/[`*_>#|]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
}

let index: SearchSection[] | null = null;

export function search(query: string, limit = 12): { s: SearchSection, snippet: string }[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  index ??= build();
  const words = q.split(/\s+/);
  const scored: { s: SearchSection, score: number }[] = [];
  for (const s of index) {
    const head = (s.page + " " + s.heading).toLowerCase();
    const body = s.text.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (head.includes(w)) score += 10;
      else if (body.includes(w)) score += 1;
      else { score = 0; break; }
    }
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ s }) => ({ s, snippet: snippet(s.text, words[0]) }));
}

function snippet(text: string, word: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const i = t.toLowerCase().indexOf(word);
  if (i < 0) return t.slice(0, 120);
  const start = Math.max(0, i - 50);
  return (start > 0 ? "…" : "") + t.slice(start, start + 140) + (start + 140 < t.length ? "…" : "");
}
