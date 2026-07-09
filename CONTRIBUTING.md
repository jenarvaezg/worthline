# Contributing to worthline

Thanks for your interest in worthline — a local-first net worth dashboard for
personal and household tracking. Contributions are welcome, whether that's a bug
fix, a feature, docs, or just a well-reported issue.

Before diving in, skim [`CONTEXT.md`](CONTEXT.md): it defines the domain
vocabulary (net worth, liquidity ladder, scopes, snapshots, FIRE) that the whole
codebase and these conventions assume.

## Licensing of contributions

worthline is licensed under [AGPL-3.0-only](LICENSE). By submitting a
contribution you agree that it is licensed under the same terms (inbound =
outbound). Don't paste code you don't have the right to relicense under AGPL.

## Prerequisites

- **Node.js 26** (see `.node-version` for local/CI; `engines.node` is `26.x` for Vercel)
- **Bun** 1.3+ (the repo pins a version via `packageManager`)

## Getting started

```bash
bun install      # install workspace dependencies
bun run dev      # run the local web app (apps/web) at http://localhost:3000
```

By default the app stores data in a local SQLite file under
`.local/worthline/` (gitignored) and runs with no auth, no telemetry, and no
cloud. See the [README](README.md#local-data) for data-path and auth options.

## The verification gate (please run this before you push)

This is the single most important step. Every change must pass:

```bash
bun run verify
```

`verify` runs `typecheck` → `biome ci` → `test` (Turborepo-cached for typecheck/test).
Biome covers lint and format in one step. Run `bun run format` to auto-fix formatting locally.

For anything that touches `apps/web` routes or pages, also run the full gate:

```bash
bun run build
```

`next build` catches Next-generated route/page types that plain `tsc` does not.
While iterating you can narrow to affected tests with `bun run test:related`.

More detail: [`docs/agents/verification-gate.md`](docs/agents/verification-gate.md).

## Project layout

A monorepo of TypeScript workspaces (see the [README](README.md#project-layout)
for the full list):

- `apps/web` — Next.js dashboard
- `packages/domain` — pure net worth domain model and calculations
- `packages/db` — persistence (SQLite / libSQL) and data-path handling
- `packages/pricing` — price-provider contracts

Imports across workspaces use zone aliases (`@web/`, `@domain/`, `@db/`,
`@pricing/`). Keep the domain package pure: no I/O, no framework imports.

## Coding conventions

- **TypeScript everywhere.** No new JavaScript source files.
- **Many small, focused files** over a few large ones; prefer immutable data and
  explicit error handling at system boundaries.
- **UI and interactions have rules.** Any visual change must follow
  [`docs/design-system.md`](docs/design-system.md); any interaction (toggles,
  filters, mutations, navigation, charts) must follow
  [`docs/interaction-patterns.md`](docs/interaction-patterns.md) (RSC-first).
- **Architectural decisions are recorded as ADRs** under
  [`docs/adr/`](docs/adr/). If your change makes or changes a structural
  decision, add or update an ADR in the same PR.

## Tests

- Keep the suite green — never leave a failing test, even a pre-existing one. If
  you touch it, you own it.
- Add or update tests for the behavior you change. The domain and db packages
  are well covered by unit/integration tests; mirror the existing style.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>
```

Types in use: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull requests

1. Branch off `main` (e.g. `fix/123-short-description`).
2. Make `bun run verify` pass locally (and `bun run build` for web changes).
3. Open a PR against `main`. Link the issue it resolves with an English closing
   keyword — `Closes #123` (GitHub only auto-closes on English keywords).
4. Keep PRs scoped to one logical change, and note in the description what
   verification you ran.

Work is organized as PRDs sliced into issues; see
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) for how issues and
PRDs are tracked. Picking up an existing `ready-for-agent` issue is the easiest
way to start.

## Reporting issues

- **Bugs and features:** open a GitHub issue with enough context to reproduce or
  motivate the change.
- **Security-sensitive issues:** worthline handles personal financial data.
  Please follow the private disclosure process in [SECURITY.md](SECURITY.md)
  instead of opening a public issue.
