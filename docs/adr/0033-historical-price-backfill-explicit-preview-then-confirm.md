# Historical price backfill is an explicit, auditable, preview-then-confirm action — never a refresh side effect

## Context

A crypto/investment added as a manual investment with backdated **operations** reconstructs its historical **units** from the operation ledger (`derivePosition`, `positions.ts`), but valuation is a different axis. When no provider price was cached on a past day, historical reconstruction values the holding **at cost basis** (units × average cost) — the ADR 0006 fallback (`atCostBasis`, `holding-valuation.ts:171-195`; `wasCapturedAtCostBasis`, `historical-snapshot-operation-ripple.ts`). The frozen `snapshot_holdings` row then carries `units` but **no** `unit_price`.

The consequence is a chart cliff. Observed in local:

- BTC bought 2021-01-01 and 2026-06-16.
- Until 2026-06-18: `0.259249 BTC × 30.000 EUR = 7.777,47 EUR` (cost).
- 2026-06-19, the first CoinGecko quote arrives: `0.259249 BTC × 54.979 EUR = 14.253,25 EUR`.
- A single-day `+6.475,78 EUR` jump that is _pure cost→price re-basing_, not a real portfolio change.

The temptation is to fix it in the **daily refresh**: the moment a live quote arrives, walk back and re-value every cost-basis snapshot. That is exactly wrong. It violates the frozen-snapshot contract (ADR 0008/0012): a refresh is a present-tense act, and silently rewriting history on every dashboard load makes the past unstable, unauditable, and surprising. It also has no honest source for _old_ prices — CoinGecko's public range endpoint caps at ~365 days (ADR 0021, `binance-history.ts:116-147`), so a naive refresh-rewrite would either invent prices or apply today's quote to 2021, both of which corrupt history.

The pieces to do it _honestly_ already exist: `fetchCoinGeckoHistoryEur` (a never-throws, demo-key-aware range fetch), `buildSnapshotAtDate` / `recalculateSnapshotForAsset` (which already reconstruct units per date and preserve every other frozen row), and `snapshot_holdings.unit_price` (which already freezes the per-day price). What is missing is a _deliberate path_ that wires them together — and the discipline that it is the **only** path that rewrites historical `unit_price`.

## Decision

Historical price backfill is an **explicit, auditable, preview-then-confirm user action** — "Rellenar histórico de precios" — never a side effect of a refresh or a dashboard load. It is the **single** path that writes historical `unit_price`; the daily refresh stays strictly present-tense and never ripples history.

The action is built from five deep, pure-where-possible modules:

- **Detection** (`packages/domain/price-backfill-detection.ts`, pure). `detectPriceBackfillCandidates` decides candidacy: an investment with a **provider symbol** AND ≥1 historical `snapshot_holding` frozen at cost basis (units present, `unit_price` absent) AND at least one operation to anchor a first date. No provider symbol → silently skipped (no source to ask). It returns the first-operation date and the count of distinct cost-basis months (the audit figures the preview surfaces).

- **Historical price source** (`packages/pricing/historical-price-source.ts`). The `HistoricalPriceSource` abstraction — `fetchSeriesEur(providerSymbol, fromMs, toMs) → { pricesByDate, source }`. Two implementations: (a) `coingeckoHistoricalSource`, which resolves the symbol → a CoinGecko id (the Binance ticker map, or a bare id passed through) and reuses `fetchCoinGeckoHistoryEur`; (b) `parsePriceCsv`, a user-controlled `date,price` CSV — the long-range fallback for ranges beyond the public endpoint's window. Neither ever invents a price: a date the source cannot price is simply absent, so the plan records a **gap**.

- **Backfill plan** (`packages/domain/price-backfill-plan.ts`, pure — the preview core). `planPriceBackfill` folds the ledger to one **monthly** point per month-start (the 1st) from the first-operation month through today, but only for a month the position actually existed (units > 0 ≤ that date, via `derivePosition`). A priced month becomes a `create`/`update` point valued at `units × price` with the price frozen; a month with a position but **no** price becomes a **gap**; a month before the first operation or after a full sell is skipped entirely (neither point nor gap). It writes nothing.

- **Apply seam** (`packages/db`, atomic). `backfillInvestmentPricesAndRipple({ assetId, pricesByDate, source, today })` runs the plan, then in **one transaction** (ADR 0020) either generates a missing monthly snapshot (`buildSnapshotAtDate` with this asset's `capturedUnitPrices`) or recalculates an existing one (`recalculateSnapshotForAsset` with a new **`overrideUnitPrice`**). The override is the only override of the "keep the price the snapshot already captured" rule (ADR 0012) — it wins over both the captured price and the cost-basis fallback, so a cost-basis row becomes `units × historical price`. Only the backfilled asset's row changes; **every other frozen row is preserved verbatim**, never recomputed from a live identity (ADR 0008), and the per-snapshot reconciliation invariant (asset rows sum to gross assets) holds.

- **Web action** (`apps/web/app/inversiones/actions.ts`). `previewPriceBackfillAction` (dry-run: counts + source + gaps, writes nothing) and `confirmPriceBackfillAction` (applies via the seam, redirects). The detail page renders the `PriceBackfillSection` ONLY when the asset is a candidate, mirroring the statement-upload preview/confirm.

## Considered options

- **Rewrite history on every refresh (rejected).** The original instinct. Violates ADR 0008/0012 (frozen snapshots, ripple only on a dated fact or parameter edit), makes the past unstable on every page load, and has no honest source for prices older than the ~365-day public window — so it would either invent prices or smear today's quote across years. The whole ADR is "do not do this."

- **Confirm without preview (rejected).** Backfill creates/updates many snapshots and chooses a source; a silent apply gives the user no chance to see how many points and which source before history changes. Mirroring the statement-upload preview/confirm (ADR 0018) gives the human check the issue's acceptance criteria demand.

- **Fabricate prices for gap months (rejected, the central guarantee).** Interpolating or carrying a neighbouring month's quote into a month the source could not price would invent data. Gaps stay gaps; the UI explains them and applies nothing for them.

- **Reuse the operation ripple unchanged (rejected).** `recalculateSnapshotForAsset` reads the price off the existing row (or cost basis) — it has no way to _inject_ a historical price. Adding the single optional `overrideUnitPrice` is the minimal extension; it is supplied ONLY by the backfill seam, so the operation ripple and the daily refresh are byte-unchanged.

- **A new historical-price provider abstraction with cron/auto-fetch (deferred).** The `HistoricalPriceSource` interface leaves room for a long-range provider later, but auto-fetching/scheduling it is out of scope: this stays a user-triggered action.

## Consequences

- **The cost→price cliff is removed deliberately.** A candidate investment shows the backfill surface; after confirm, its monthly rows rise smoothly with the historical price instead of jumping the day the first live quote arrives.

- **History has exactly one writer.** `backfillInvestmentPricesAndRipple` is the only path that rewrites historical `unit_price`. The daily refresh (`refreshStalePrices`, `refreshPricesAction`) is unchanged and provably does not ripple history (guarded by test). The `overrideUnitPrice` override exists in `recalculateSnapshotForAsset` but is supplied by no other caller.

- **Auditable source.** The source label (`coingecko`, or a CSV import) is carried through the plan and surfaced both in the preview **and** in the post-confirm success banner ("Histórico de precios rellenado desde &lt;source&gt;.", carried in the redirect's `source` param), so a completed backfill is traceable, not only the dry run. (There is no per-row source column yet; a durable `price_source` column on `snapshot_holdings` is a possible future extension.)

- **The whole monthly series is restated, not only cost-basis gaps.** Every position-bearing month the source can price becomes an `update` point and `overrideUnitPrice` wins unconditionally — including a month whose row already carried a genuine captured price. This is intentional: the backfill restates the series from the chosen source so the line is internally consistent, rather than splicing source prices only into the cost gaps. Impact is bounded (for the asset's own provider the source matches the captured price), but a backfill can restate an already-honest month, so it is gated behind the explicit preview-then-confirm.

- **Preview counts are scope-aware.** The preview runs `backfillInvestmentPricesAndRipple({ dryRun: true })` — the same per-scope apply loop, counting only — so the surfaced create/update figures equal what confirm writes even in household mode (where one asset spans household + members + groups). The scope-agnostic plan counts would undercount by the scope multiplier; the dry run is the single source of truth.

- **Gaps are honest.** A range the source cannot cover yields gaps the UI explains; the CSV import is the escape hatch for ranges beyond the public endpoint's window. No price is ever invented.

- **No new domain noun.** "Backfill", "ripple recalculation", "snapshot", "cost basis", and "operation" already name these concepts (CONTEXT.md, ADR 0006/0008/0012). The historical price backfill is a _new action_ over existing terms, not a new kind of snapshot — a backfilled snapshot is an ordinary snapshot on a past date.
