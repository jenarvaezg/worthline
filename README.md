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

Run verification:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

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
