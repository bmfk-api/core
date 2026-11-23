# @bmfk/api-docs

The interactive API documentation of `@bmfk/api`: endpoint groups, validation models, a request builder with
code examples. A React app built into a single `index.html` that the library serves.

```bash
npm run build -w @bmfk/api-docs   # → dist/index.html, copied to packages/api/src/apiServer/documentation/
npm run dev -w @bmfk/api-docs     # dev server on http://localhost:3001
```

Not published on its own (`private`). Components and signal hooks come from `packages/ui`.
