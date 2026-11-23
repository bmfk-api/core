# @bmfk/monitor

The operations console of `@bmfk/api`: metrics, logs, request journals, threats, process restart, behind
password + 2FA. A React app built into a single `index.html` that the library serves at `<baseEndPoint>sm/html`.

```bash
npm run build -w @bmfk/monitor   # → dist/index.html, copied to packages/api/src/apiServer/monitor/
npm run dev -w @bmfk/monitor     # dev server on http://127.0.0.1:3000
```

Not published on its own (`private`). Signals: `src/lib/signals.ts` (the library's `Signal`/`Req` plus
React hooks). UI components: `src/ui/`.
