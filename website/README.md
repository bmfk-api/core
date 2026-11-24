# bmfk website

Documentation site for the framework: React, TypeScript and Vite. Pages are MDX in `src/docs/`; code is
highlighted at build time, so no highlighter ships to the browser.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + static build into dist/
npm run preview    # serve dist/ locally
```

Works on Node 21 and later.

## Editing

- **A page:** edit `src/docs/<slug>.mdx`. Prose is Markdown; `<Callout kind="note|warn|security" title="…">`,
  `<Cards>` and `<Card>` are available without imports.
- **A new page:** add `src/docs/<slug>.mdx` and an entry in `src/docs/nav.ts`; it then appears in the sidebar,
  the pager and search.
- **Names:** `src/site.ts` holds the product name, npm package and CLI name. In code blocks and inline code of
  `.mdx` files, `{{pkg}}`, `{{cli}}` and `{{name}}` are replaced with them at build time, so a rename is a
  change in one file.

## Deploying

`npm run build` prerenders every page into its own HTML file (`dist/docs/<slug>/index.html`, with its title,
description, canonical URL and Open Graph tags), and writes `404.html`, `sitemap.xml` and `robots.txt`. The site
address is `url` in `src/site.ts`. The pages are readable without JavaScript; React takes over in the browser.

`dist/` can go through the framework's own deployer (a project without `./bin` and with `dist/index.html` is
shipped as a static site). The web server serves the page files and answers unknown paths with a real 404:

```nginx
server {
  server_name bmfk.net;
  root /path/to/dist;
  location / {
    try_files $uri $uri/index.html =404;
  }
  error_page 404 /404.html;
}
server {
  server_name www.bmfk.net;
  return 301 https://bmfk.net$request_uri;
}
```

Fonts are bundled, so the site makes no third-party requests.
