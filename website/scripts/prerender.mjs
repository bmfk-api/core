// After `vite build` and the SSR build: one HTML file per page (with its own title, description, canonical
// and Open Graph tags), 404.html, a /docs redirect, sitemap.xml and robots.txt. The SSR build is removed.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const ssr = join(root, "dist-ssr");
const { pages, notFound, render, site } = await import(pathToFileURL(join(ssr, "entry-server.js")).href);
const siteUrl = site.url;

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const template = readFileSync(join(dist, "index.html"), "utf-8");
const ROOT = '<div id="root"></div>';
const DESCRIPTION = /<meta name="description" content="([^"]*)" \/>/;
if (!template.includes(ROOT) || !DESCRIPTION.test(template) || !/<title>[^<]*<\/title>/.test(template))
  throw new Error("prerender: dist/index.html no longer has the expected root, title and description");
const defaultDescription = template.match(DESCRIPTION)[1];

async function page({ path, title, description, csp }, { index }) {
  const desc = description ? esc(description) : defaultDescription;
  const url = siteUrl + (path === "/" ? "/" : path);
  const head = index
    ? [
        `<link rel="canonical" href="${url}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="${esc(site.name)}" />`,
        `<meta property="og:title" content="${esc(title)}" />`,
        `<meta property="og:description" content="${desc}" />`,
        `<meta property="og:url" content="${url}" />`,
        `<meta name="twitter:card" content="summary" />`,
      ]
    : [`<meta name="robots" content="noindex" />`];
  const html = await render(path);
  // Replacers are functions: page text with "$&" or "$'" must not be read as a replacement pattern.
  return template
    .replace(/<meta charset="UTF-8" \/>/i, m => csp ? `${m}\n    <meta http-equiv="Content-Security-Policy" content="${esc(csp)}" />` : m)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(DESCRIPTION, () => `<meta name="description" content="${desc}" />`)
    .replace("</head>", () => `    ${head.join("\n    ")}\n  </head>`)
    .replace(ROOT, () => `<div id="root">${html}</div>`);
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

for (const p of pages)
  write(join(dist, p.path === "/" ? "index.html" : join(p.path, "index.html")), await page(p, { index: true }));
write(join(dist, "404.html"), await page(notFound, { index: false }));

const intro = `${siteUrl}/docs/introduction`;
write(join(dist, "docs", "index.html"),
  `<!doctype html>\n<meta charset="utf-8" />\n<title>Redirecting…</title>\n<link rel="canonical" href="${intro}" />\n` +
  `<meta http-equiv="refresh" content="0; url=/docs/introduction" />\n<a href="/docs/introduction">${intro}</a>\n`);

write(join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  pages.map(p => `  <url><loc>${siteUrl}${p.path}</loc></url>\n`).join("") + `</urlset>\n`);
write(join(dist, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);

rmSync(ssr, { recursive: true, force: true });
console.log(`prerendered ${pages.length} pages, 404.html, sitemap.xml, robots.txt`);
