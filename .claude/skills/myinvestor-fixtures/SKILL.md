---
name: myinvestor-fixtures
description: >-
  Regenerates the anonymized MyInvestor API fixtures of the connector (#1876) from
  real captures: download with myinvestor-cli, anonymize, run the careo, commit.
  Use when the MyInvestor API changes, when a connector slice needs a response that
  has no fixture yet, or when asked to refresh or extend the MyInvestor fixtures.
user-invocable: true
---

# MyInvestor fixtures

The connector's tests run against `packages/pricing/src/__fixtures__/myinvestor/`:
`capture/` comes from real responses through the anonymizer, `synthetic/` is written by
hand. Every folder has a `manifest.json` with the request each body answers.

How `capture/` is made, in two passes:

1. **Anonymize** (`anonymize.ts`): identifiers become stable fakes; every amount and
   share count becomes its own invented figure (`figure-map.ts`): the same real value
   always gives the same fake, so equalities survive, but there is no common factor.
   Dates, ISIN, DGS codes, tickers, types and prices stay real.
2. **Rebuild** (`rebuild.ts`): each order's shares come from its invented amount and its
   real price; positions, invested, values, account totals, `withheldBalance` and the
   plans' `SINCE_BEGINNING` series are recalculated from the invented orders, so P8 and
   "withheld = Σ `amountToBlock` in progress" hold. A figure that would equal a real one
   of the capture is nudged one share unit away.

The repo is public. The rules below are not negotiable:

- **Raw captures never enter git.** They live in `.local/myinvestor-raw/` of the main
  checkout (git ignores `.local/`). In a worktree, point at that absolute path.
- **The secret never enters git.** It lives in `.local/myinvestor-fixtures.secret`
  (`openssl rand -hex 32`, mode 600). Lose it and every fake changes on the next run:
  not a leak, just a noisy diff. Never print it.
- **Nothing from a raw capture goes anywhere tracked**: not in fixtures, tests, commit
  messages, PR bodies, issues or this skill. Talk about counts and shapes, never values.
- **No human reviews the fixtures. The careo does**, and it must say `Careo limpio`
  before any commit that touches them.
- **Read-only against MyInvestor.** `myinvestor raw` only does GET. If the CLI session
  asks for an SMS, stop and ask the owner of the account; never retry a rejected password.

## Steps

1. **Download.** `.claude/skills/myinvestor-fixtures/capture.sh` (it writes one `.json`
   per call, named `<endpoint>[-<accountId>]`). Completion: no `.err` file with content.
2. **Anonymize.**

   ```sh
   MYINVESTOR_RAW_DIR=<main checkout>/.local/myinvestor-raw bun run fixtures:myinvestor
   ```

   It rewrites `capture/` and its manifest, refuses to write if the invented amounts
   keep a common factor with the real ones, formats with Biome, and runs the careo.
   The secret is read from `myinvestor-fixtures.secret` next to the raw folder
   (`MYINVESTOR_FIXTURE_SECRET_FILE` or `MYINVESTOR_FIXTURE_SECRET` to override).
3. **Careo.** Already run by step 2; on its own: `bun run fixtures:myinvestor check`
   (needs the raw captures, not the secret). It must end in `✓ Careo limpio`. It checks
   the fixture bodies field by field, and every line the work adds against `origin/main`
   (`MYINVESTOR_CAREO_BASE` to change it) — code, tests, comments, docs, this skill —
   plus the branch's commit messages: no real identifier, name or figure, and no valid
   IBAN or DNI/NIE written whole. Test values are invented, never copied from a capture.
4. **Tests.** `bunx vitest run --config packages/pricing/vitest.config.ts
   packages/pricing/src/myinvestor/fixtures` — the guards that also run in CI: no valid
   IBAN/DNI/NIE in any fixture, manifests match files, P8 (today's shares rebuild
   exactly from the COMPLETE orders) on every plan, fund and stock, and every cash
   account holds back exactly what its orders in progress block.
5. **Commit** with explicit paths (`git add packages/pricing/src/__fixtures__/myinvestor`),
   never `git add -A`. Then `git grep` a couple of raw identifiers (read them from the raw
   files into a shell variable, never type them) to confirm nothing tracked has them.

## When something stops you

- **`Clave sin clasificar en field-policy.ts: <path>`**: the API added a field. Decide
  what it is in `packages/pricing/src/myinvestor/fixtures/field-policy.ts`: `amount` for
  money, `quantity` for shares, a pseudonym rule for anything that identifies a person or
  an account, `public` only for enums, codes, operation dates, prices and returns. When in
  doubt it is not `public`. If the API derives the new figure from others (a total, a
  value), recalculate it in `rebuild.ts` too.
- **`Captura desconocida: <name>`**: a new endpoint. Add it to `capture-plan.ts`
  (`SINGLE`, `PER_ID` or `SKIPPED`) with its path and query. A new kind of order also
  needs its sign in `rebuild.ts` and in `committed-fixtures.test.ts`.
- **`Careo SUCIO`**: it lists file, kind and a masked hint. Fix the field policy, the
  rebuild or the synthetic file; never edit a capture fixture by hand. An `amount` hit in
  a synthetic file means a hand-made figure equals a real one: change the figure. A hit on
  a recalculated total that no single order controls: add the check to `Ledger.settle`.
- **`factor común`**: the invented amounts follow the real ones by one ratio. Something
  bypassed `figure-map.ts`; find it before writing anything.
- **A synthetic case** (something the real account does not have): add the body to
  `synthetic/` and its entry to `synthetic/manifest.json`, invented values only, IBANs and
  documents with broken control digits. Keep P8 true if it has orders and positions.

## What lives where

| Piece | Path |
| --- | --- |
| Anonymizer, careo, guards | `packages/pricing/src/myinvestor/fixtures/` |
| Command | `scripts/myinvestor-fixtures.ts` (`bun run fixtures:myinvestor`) |
| Fixtures and manifests | `packages/pricing/src/__fixtures__/myinvestor/` |
| Raw captures, secret | `.local/` of the main checkout, never in git |

## Left out on purpose

- The customer profile and the day-by-day cash balance: the most personal, and the
  connector does not read them.
- The `SINCE_BEGINNING` series of the securities accounts: the connector rebuilds funds
  and stocks from their orders. They are still captured: the careo checks against them.

## Known limits

- Dates, instruments and the number of orders are real, so the pattern of activity (when
  someone contributes, which funds) is visible. Only amounts and shares are invented.
- `enabledBalance` has no order behind it: it is an invented figure, not a recalculation.
