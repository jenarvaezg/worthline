# worthline

Local-first net worth dashboard for personal and household tracking.

## Commands

Install dependencies (requires [Bun](https://bun.sh) 1.3+ and Node.js 26+):

```bash
bun install
```

Run the local web app:

```bash
bun run dev
```

Run the fast verification gate (inner-loop and default CI check):

```bash
bun run verify
```

`verify` runs `typecheck` + `biome ci` + `test` without invoking a full
`next build`. Typecheck and test are orchestrated by Turborepo, so unchanged
packages are skipped across runs ("FULL TURBO" cache hit). Biome (lint + format)
runs at the repo root.

Run the full production/deploy gate (pre-push / before deploy):

```bash
bun run build
```

This still triggers `apps/web`'s `next build`, which catches Next-generated
route/page types that plain `tsc` does not see.

Run only tests related to changed files (useful while iterating):

```bash
bun run test:related
```

Turborepo caches tasks under `.turbo/` locally. **Remote cache** (Vercel, free on Hobby) is enabled in CI when `VERCEL_TOKEN` and `TURBO_TEAM` are set — see [`docs/agents/turbo-remote-cache.md`](docs/agents/turbo-remote-cache.md).

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
WORTHLINE_DATA_DIR=/path/to/private/data bun run dev
```

or:

```bash
WORTHLINE_DB_PATH=/path/to/worthline.sqlite bun run dev
```

## Authentication (optional)

worthline can run in two modes:

- **Local no-auth mode** (default): `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and
  `AUTH_SECRET` are unset. The app opens a local SQLite file and works offline,
  exactly as before.
- **Hosted mode**: set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`,
  `WORTHLINE_DB_URL`, and `WORTHLINE_DB_AUTH_TOKEN`. Signed-out visitors are
  redirected to `/login`; signed-in users open the configured remote libSQL
  workspace.

To set up Google sign-in:

1. Create an OAuth 2.0 Web application credential in [Google Cloud Console](https://console.cloud.google.com/).
2. Add the authorized redirect URI:
   - Local: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://<your-domain>/api/auth/callback/google`
3. Copy the Client ID and Client Secret into `.env.local` as `AUTH_GOOGLE_ID`
   and `AUTH_GOOGLE_SECRET`.
4. Generate `AUTH_SECRET` with `openssl rand -base64 32`.

No auth, telemetry, cloud sync, personal spreadsheet data, or machine-specific absolute paths
are required for the bootstrap slice.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) — the
short version is: run `bun run verify` before you push, follow Conventional
Commits, and respect the design-system and interaction-pattern docs for any UI
change.

## License

Copyright © 2026 Jose Enrique Narváez Gago.

worthline is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). If you run a modified version as a network service, you must make
your source available under the same terms.
