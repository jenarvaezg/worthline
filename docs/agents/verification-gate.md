# Verification gate

## Scripts

- `bun run verify` — fast inner-loop and default CI gate.
  Runs `typecheck` → `biome ci` → `test`.
  Does **not** run `next build`.
- `bun run lint` — `biome ci` (lint + format check).
- `bun run format` — `biome format --write .` (fix formatting locally).
- `bun run build` — full production gate, including `apps/web`'s `next build`.
  Use before deploy / as a pre-push gate.
- `bun run test:related` — run only the tests related to changed files.
  Useful when iterating on a single change.

## Caching

Tasks are orchestrated by Turborepo. `typecheck`, `test`, and `build` are cached
per package under `.turbo/` (gitignored), keyed on input hashes. A change scoped
to one package re-runs only that package and its dependents ("FULL TURBO" when
nothing changed).

Biome runs at the repo root (not per-package via Turbo).

## Why two gates?

`next build` is expensive and is only needed to validate Next-generated route
and page types that plain `tsc --noEmit` cannot see. For everyday iteration and
most CI checks, `bun run verify` is enough. The full `bun run build` stays as the
deploy / pre-push correctness gate.

## Turborepo

- Local caching only; remote cache is intentionally out of scope.
- Task graph respects `@worthline/*` workspace boundaries.
