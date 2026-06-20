# worthline

Local-first net worth dashboard for personal and household tracking.

## Commands

Install dependencies:

```bash
npm install
```

Run the local web app:

```bash
npm run dev
```

Run the fast verification gate (inner-loop and default CI check):

```bash
npm run verify
```

`verify` runs `typecheck` + `test` + `lint` + `format` without invoking a full
`next build`. Tasks are orchestrated by Turborepo, so unchanged packages are
skipped across runs ("FULL TURBO" cache hit). Lint and format also use tool-level
caches under `node_modules/.cache/`.

Run the full production/deploy gate (pre-push / before deploy):

```bash
npm run build
```

This still triggers `apps/web`'s `next build`, which catches Next-generated
route/page types that plain `tsc` does not see.

Run only tests related to changed files (useful while iterating):

```bash
npm run test:related
```

Turborepo caches tasks under `.turbo/` (gitignored). Remote caching is not
configured; everything works locally with no external account.

## Project Layout

- `apps/web`: Next.js local dashboard.
- `packages/domain`: shared net worth domain model and calculations.
- `packages/db`: SQLite persistence and local data path handling.
- `packages/pricing`: price provider contracts and manual fallback placeholder.
- `packages/contracts`: shared TypeScript contracts for web, domain, db, and future mobile.

The package boundaries are intentionally mobile-ready: the future Expo app should reuse
`packages/domain`, `packages/contracts`, and provider contracts instead of copying web logic.

## Local Data

By default the app stores SQLite data under:

```text
.local/worthline/worthline.sqlite
```

The directory is ignored by git. Override it with either:

```bash
WORTHLINE_DATA_DIR=/path/to/private/data npm run dev
```

or:

```bash
WORTHLINE_DB_PATH=/path/to/worthline.sqlite npm run dev
```

No auth, telemetry, cloud sync, personal spreadsheet data, or machine-specific absolute paths
are required for the bootstrap slice.
