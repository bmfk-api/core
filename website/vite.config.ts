import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import { createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { remarkSiteTokens } from "./src/lib/remarkSiteTokens";

// The JavaScript regex engine instead of the WASM one: same output, and it runs on Node 21 too.
const highlighter = await createHighlighter({
  themes: ["github-light", "github-dark-dimmed"],
  langs: ["ts", "tsx", "js", "json", "jsonc", "bash", "http", "text", "nginx"],
  engine: createJavaScriptRegexEngine(),
});

const mdxPlugin = mdx({
  remarkPlugins: [remarkGfm, remarkSiteTokens],
  rehypePlugins: [
    rehypeSlug,
    // Highlighted at build time: no highlighter ships to the browser.
    [rehypeShikiFromHighlighter, highlighter, {
      themes: { light: "github-light", dark: "github-dark-dimmed" },
      defaultColor: false,
    }],
  ],
});

export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      ...mdxPlugin,
      // The MDX plugin drops the query: "page.mdx?raw" (the search index) would be compiled too.
      transform(code, id) {
        if (/[?&]raw\b/.test(id)) return null;
        return (mdxPlugin.transform as any).call(this, code, id);
      },
    },
    react({ include: /\.(mdx|tsx?)$/ }),
  ],
});
