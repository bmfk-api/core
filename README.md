# bmfk — Backend Modular Framework Kit

| Folder | What |
|---|---|
| [`packages/api`](packages/api) | `@bmfk/api` — the framework |
| [`packages/monitor`](packages/monitor) | the operations console (React), built into `@bmfk/api` as one `index.html` |
| [`packages/api-docs`](packages/api-docs) | the interactive API documentation (React), built into `@bmfk/api` the same way |
| [`packages/ui`](packages/ui) | components and React signal hooks shared by the two UIs |
| [`examples/sandbox`](examples/sandbox) | everything running locally, to try by hand (`npm run sandbox`) |
| [`website`](website) | the site and documentation |

```bash
npm ci
npm test         # @bmfk/api tests
npm run build    # monitor and API-docs UIs, then @bmfk/api → packages/api/dist
npm run monitor  # monitor UI dev server (:3000)
npm run api-docs # API-docs UI dev server (:3001)
npm run website  # the site → website/dist
npm run sandbox  # the sandbox on http://localhost:18900/api/demo/page
```

Security: see [SECURITY.md](SECURITY.md).
