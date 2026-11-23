import { site } from "../site";

const TOKENS: Record<string, string> = { pkg: site.pkg, cli: site.cli, name: site.name };
const RE = /\{\{(pkg|cli|name)\}\}/g;

export function replaceTokens(s: string): string {
  return s.replace(RE, (_: string, k: string) => TOKENS[k]);
}

// Replaces {{pkg}}, {{cli}} and {{name}} in text, inline code and code blocks of the docs.
export function remarkSiteTokens() {
  const walk = (node: any) => {
    if (typeof node.value === "string" && (node.type === "text" || node.type === "inlineCode" || node.type === "code"))
      node.value = replaceTokens(node.value);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  return (tree: any) => walk(tree);
}
