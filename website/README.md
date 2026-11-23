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

`dist/` is a static single-page app. It can go through the framework's own deployer (a project without
`./bin` and with `dist/index.html` is shipped as a static site). The web server must answer unknown paths with
`index.html` so deep links work:

```nginx
location / {
  try_files $uri /index.html;
}
```

Fonts are bundled, so the site makes no third-party requests.
