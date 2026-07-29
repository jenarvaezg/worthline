# Verification gate

## Scripts

- `bun run verify` — fast inner-loop and default CI gate.
  Runs `typecheck` → `typecheck:e2e` → `biome ci` → `test`.
  Does **not** run `next build`.
- `bun run typecheck:e2e` — `tsc --noEmit -p tsconfig.e2e.json`.
  Separate step because `typecheck` is `turbo run typecheck`, i.e. the per-workspace
  task, and the `e2e/` tree is not a workspace: its tsconfig is only read by
  Playwright, which compiles with esbuild — types erased, never checked (#1274).
  Bare `tsc`, so it stays outside the Turbo cache.
- `bun run lint` — `biome ci` (lint + format check).
- `bun run format` — `biome format --write .` (fix formatting locally).
- `bun run build` — full production gate, including `apps/web`'s `bun --bun next build`.
  Use before deploy / as a pre-push gate. Vercel Functions stay on Node 24 — see [`bun-runtime.md`](bun-runtime.md).
- `bun run test:related` — run only the tests related to changed files.
  Useful when iterating on a single change.

## Caching

Tasks are orchestrated by Turborepo. `typecheck`, `test`, and `build` are cached
per package under `.turbo/` (gitignored), keyed on input hashes. A change scoped
to one package re-runs only that package and its dependents ("FULL TURBO" when
nothing changed).

**Remote cache:** CI/deploy set `TURBO_TOKEN` (from `TURBO_CACHE_TOKEN`, a cache-scoped
Vercel token — falling back to `VERCEL_TOKEN` until that secret exists, #1180) + `TURBO_TEAM`
for Vercel Remote Cache (shared across jobs and runs). Setup:
[`docs/agents/turbo-remote-cache.md`](docs/agents/turbo-remote-cache.md).

Biome runs at the repo root (not per-package via Turbo).

## Why two gates?

`next build` is expensive and is only needed to validate Next-generated route
and page types that plain `tsc --noEmit` cannot see. For everyday iteration and
most CI checks, `bun run verify` is enough. The full `bun run build` stays as the
deploy / pre-push correctness gate.

## Turborepo

- Remote cache via Vercel when `TURBO_CACHE_TOKEN` (or, as fallback, `VERCEL_TOKEN`) + `TURBO_TEAM` are configured (see [`turbo-remote-cache.md`](turbo-remote-cache.md)).
- Task graph respects `@worthline/*` workspace boundaries.
