# Single staleness rule: per-source TTL wins

Two independent staleness rules existed side by side:

1. `PRICE_TTL_DAYS` in `packages/domain/src/prices.ts` — a per-source table
   (manual = 30 days, ecb / coingecko / stooq = 1 day).
2. `STALE_THRESHOLD_MS` in `packages/domain/src/price-staleness.ts` — a fixed
   24-hour constant applied uniformly to all non-manual, non-failed entries.

`selectStalePrices` used rule 2 only; `getPriceFreshness` used rule 1. The two
functions answered different questions using different thresholds, so "is this
price stale?" had two different answers depending on which function you called.

We reconciled them: **the per-source TTL table wins**. `selectStalePrices` now
lives in `prices.ts` alongside `PRICE_TTL_DAYS` and uses `ageMs >= ttlMs` per
source. The fixed `STALE_THRESHOLD_MS` constant is gone.

## Observable behaviour change

For the three provider sources (ecb, coingecko, stooq) the TTL is 1 day
(86 400 000 ms), which is identical to the former fixed 24-hour threshold.
**There is no change in refresh cadence for any currently wired source.**

The manual tier's 30-day TTL now appears in `selectStalePrices`, but manual
entries are excluded first by the `freshnessState === "manual"` guard, so the
30-day path is effectively unreachable in normal operation. This guard was
already present before the reconciliation.

## Why per-source TTL

Having one table as the single source of truth lets a future provider with a
different freshness contract (e.g. an end-of-day-only feed that is stale after
48 h, or a real-time feed stale after 5 min) configure its TTL in one place and
have both `getPriceFreshness` and `selectStalePrices` honour it automatically.
The fixed-constant approach would require updating two independent thresholds.

## Consequences

- `packages/domain/src/price-staleness.ts` is now a re-export shim (deprecated).
  It will be removed once `packages/pricing` migrates its import.
- `packages/domain/src/index.ts` re-exports `selectStalePrices` from `prices`.
- The refresh orchestration (determine stale → fetch → persist) is extracted
  into `apps/web/app/refresh-prices.ts`; both consuming pages delegate to it.
