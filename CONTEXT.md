# worthline Context

`worthline` is a personal-first, local-first net worth dashboard.

The product tracks total net worth, liquid net worth, housing-inclusive net worth,
gross assets, debts, ownership splits, liquidity tiers, frozen snapshots, and FIRE
progress. The MVP starts as a local web app backed by SQLite, with shared TypeScript
domain packages so a future mobile app can reuse the same calculations.

## Current Architecture

- Next.js powers the local web dashboard in `apps/web`.
- SQLite persistence lives in `packages/db`.
- Shared domain logic lives in `packages/domain`.
- Cross-package data contracts live in `packages/contracts`.
- Pricing provider contracts live in `packages/pricing`.

## Product Constraints

- Manual-first data entry.
- EUR base currency.
- Money amounts are represented as integer minor units.
- Decimal quantities, FX rates, and prices should use decimal strings.
- Local data must stay outside git.
- No auth, telemetry, cloud sync, or personal spreadsheet assumptions in the MVP.
