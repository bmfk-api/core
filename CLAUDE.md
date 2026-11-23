# bmfk monorepo

- `packages/api` — `@bmfk/api`, the framework. `website` — the site (Vite + MDX); its texts are edited by the owner.
- Build: `npm run build`; tests: `npm test` (node:test, compiled into `packages/api/build-test`); site: `npm run website`.
- Node: the current LTS lines (`engines` >= 24; CI on 24 and 26).
- Publishing happens only from CI (`.github/workflows/release.yml`, tag `vX.Y.Z`). Never bump versions or publish locally.
- `packages/api/CHANGELOG.md`: every change gets an entry under the next version, headed `## <version> — <YYYY-MM-DD>`, never "unreleased".
- No compatibility with the legacy API server (6.x), on the network or on disk: it is a different product. Don't add code to accept old formats, labels or names.
- Built-in UIs: `packages/monitor` (operations console) and `packages/api-docs` (API documentation), React 19 + Vite, one-file builds. Root `npm run build` builds both, copies them to `packages/api/src/apiServer/{monitor,documentation}/index.html` (gitignored), then builds the library. Shared components and the React signal hooks (`.use()`, `.useRequest()`, `onSubscribe` on top of the library's Signal/Req — the library has no React) are in `packages/ui`, imported as `ui/src/...` (tsconfig paths).
- Data folder on servers: `/var/bmfk/<project>/` (override `BMFK_DATA_DIR`); tests point it at a temp folder.
- Every 1.0 change that affects a project moving from the legacy server goes into `docs/migration-from-legacy.md`. Call it "the legacy server" / "6.x" in docs, help texts and comments; its package names appear only where `bmfk migrate` must match them (`MigrateProject.ts`, its tests).
