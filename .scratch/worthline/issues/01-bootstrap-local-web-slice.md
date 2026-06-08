Status: completed
Title: Bootstrap local web slice

## Parent

.scratch/worthline/PRD.md

## What to build

Create the initial `worthline` project skeleton as a local-first web app. The slice should produce a runnable local dashboard shell with a SQLite-backed persistence path, TypeScript domain package boundaries, a test runner, and enough project documentation for another agent or developer to run and verify the app.

This slice should not implement real net worth features yet. It should establish the vertical path that later slices can extend: local web UI, shared domain code, database access, and tests.

## Acceptance criteria

- [x] A local development command starts the web app and shows a `worthline` dashboard shell.
- [x] The project structure separates web UI, shared domain logic, database/persistence, pricing/contracts placeholders, and future mobile-ready packages.
- [x] SQLite is wired in locally with a minimal health/check path that proves the app can read/write application data.
- [x] TypeScript, linting/formatting conventions, and a test runner are configured.
- [x] At least one smoke test verifies the app/domain bootstrap path.
- [x] Project docs explain how to install dependencies, run the app, run tests, and where local data is stored.
- [x] No auth, telemetry, cloud sync, personal data, or hardcoded local machine assumptions are introduced.

## Blocked by

None - can start immediately

## Implementation

Completed in the local repository bootstrap. Verified with `npm test`, `npm run typecheck`,
`npm run lint`, `npm run build`, local HTTP render, SQLite healthcheck file creation, and
desktop/mobile screenshots.
