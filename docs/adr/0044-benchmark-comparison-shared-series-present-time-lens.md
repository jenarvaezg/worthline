# Benchmark comparison is a present-time lens over a shared, control-plane series catalog — inflation globally, a tracked index per holding

## Context

worthline computes how a portfolio and its holdings have **grown** — net worth over
time from snapshots (ADR 0008), and, with PRD #547, money-/time-weighted **returns**
(ADR 0040). But it answers growth in a vacuum: "+12% over two years" says nothing about
whether that beat the alternative of doing nothing, or keeping pace with the market. The
missing question is **"am I doing well, or do I need to up my game?"** — a comparison
against a benchmark over time.

Two facts shape the design. First, the comparison only ever **reads** existing growth
series and an external reference series; it never produces a figure the net-worth math
consumes — the same shape as exposure (ADR 0039) and returns (ADR 0040). Second, the
reference series themselves (a price index, the CPI) are **identical for every tenant**
and have **no free per-render feed** — they must be fetched once and cached historically,
the way `asset_price_cache` already caches prices. The decisive constraint recorded in
ADR 0035 / 0040 stands: worthline keeps **no historical price series** of its own, so a
benchmark series is **new cached reference data**, not a reconstruction of the past.

The product split is sharp. Comparing the **whole patrimony** against a market index is
apples-to-oranges (cash, property and crypto are not "the market"); the meaningful global
benchmark is **inflation** — "is my purchasing power growing?". A **per-holding** fund vs
the index it tracks is the meaningful market comparison, and ADR 0040 already noted that
its **time-weighted return** is the measure that plugs in, reusing the **tracked-index**
label from ADR 0039.

## Decision

Introduce a **benchmark comparison**: a present-time lens that overlays a stored
**benchmark series** on an existing growth series, at two levels.

- **Two levels, two benchmarks.** **Globally**, net worth is compared against
  **inflation** (Spanish CPI from INE in v1; the source is country-configurable later).
  **Per holding**, a fund is compared against the **market index it tracks** — keyed by
  the ADR 0039 `tracked-index` label resolved to a catalog `series_id`.
- **A shared series catalog lives in the control plane.** A `benchmark_prices(series_id,
date, value)` table sits in the **control-plane** database (ADR 0030), not per
  workspace: a benchmark series depends on no tenant's holdings and is identical for all,
  so it is fetched **once for the whole fleet** — mirroring the daily cron's existing
  cross-tenant price dedup (`fetchPrices` over distinct pairs, PRD #528). Any shared,
  tenant-independent reference series belongs in the control plane by the same logic.
- **Monthly cadence.** One row per series per month (the clean periodic series, aligned
  to the **monthly close** ADR 0040's TWR already uses; CPI is monthly by nature). Daily
  is rejected as overkill — the evolution reading is a trend, not a tick.
- **The comparison is a present-time, non-figure lens; the series is cached reference
  data.** The overlay ("net worth +12% vs CPI +6%") is computed at read time by crossing
  the **snapshot** series (already stored) with the **benchmark** series, rebased to 100
  at the window start. It is **never frozen into a snapshot**, never enters reconciliation,
  and never alters net worth — ADR 0008 is untouched. Only the raw benchmark series is
  stored (a cache, like prices); correcting the catalog re-derives past comparisons,
  because the comparison is a lens, not a frozen fact.
- **Backfill is lazy and idempotent, isolated from snapshot capture.** The daily cron
  (PRD #528) gains a **best-effort benchmark phase**: per catalog series it fetches only
  the months missing from `benchmark_prices` (the free INE/Stooq APIs serve full history),
  so the first run backfills the existing window and later runs append the new month. The
  benchmark phase **never blocks or fails** the snapshot capture that is the cron's primary
  job; a source outage just leaves the line un-advanced until the next run retries the
  missing months. No separate backfill script.
- **Total-return vs price-index honesty, with both variants.** A price index excludes
  dividends, so an accumulating fund would beat it artificially; a total-return series (an
  accumulating-ETF NAV proxy) is the fair comparison. Because ADR 0040 does **not** model
  the distributions a distributing fund pays out, that fund's tracked value excludes them
  too — so it is fairly compared against the **price** index. The catalog therefore stores
  **both variants where freely available**; the default mapping is **total-return** (most
  index ETFs / pension plans accumulate), and the price variant is **opt-in per holding**
  via a manual "distributing" flag (worthline stores no distribution policy today). Each
  series carries a coverage note (total-return / price-only) surfaced beside the
  comparison, the same honest-signal pattern as ADR 0040.
- **Coverage is honest.** A holding whose `tracked-index` maps to no catalog series shows
  no line; the global comparison is null with a reason when the CPI series is unavailable.
  Never a fabricated number.
- **The MCP exposes the comparison**: the global vs-inflation block extends
  `get_financial_context`; the per-holding vs-index block extends `get_holding_detail`
  beside `returns` — forecast/lens clearly labelled, gated like its underlying data.

## Considered options

- **Whole patrimony vs a market index (rejected as the global benchmark).** Mixes
  non-market assets (cash, property) into a market comparison; the number misleads.
  Inflation is the meaningful whole-net-worth benchmark; a market index belongs at the
  per-holding level.
- **Benchmark series per workspace (rejected).** Duplicates the identical S&P/CPI series
  across every tenant DB and multiplies the fetch. The series is tenant-independent →
  control plane, fetched once.
- **A constant-CAGR benchmark line (rejected).** Zero infra, but it has no real _path_ —
  it cannot answer an "over time" comparison, which is the whole point.
- **Forward-only capture, no backfill (rejected).** Leaves the existing ~2 years of
  history with an empty comparison; the free APIs serve full history, so lazy backfill is
  nearly free.
- **A standalone per-holding "pick a benchmark" UI (rejected for v1).** A second surface
  to assign benchmarks duplicates ADR 0039's `tracked-index`; reuse that label resolved to
  a `series_id` instead (soft coordination with #539 S1 so the field resolves against the
  catalog). Fall back to a standalone selector only if that coordination proves impossible.
- **Daily benchmark cadence (rejected).** Overkill for a trend reading; CPI is monthly
  anyway and TWR already chains monthly closes.
- **Freezing the comparison / a "real net worth" figure into snapshots (rejected).** Would
  touch ADR 0008 and make a lens into a stored figure. Present-time derivation answers the
  question without that weight; a deflated "real net worth" line stays derivable on demand.
- **A paid clean total-return feed (rejected).** Against the cloud-free spirit; free Stooq
  proxies + INE cover the real portfolio, with coverage notes for the gaps.

## Consequences

- worthline gains a verdict layer: net worth vs inflation (real growth) globally, and
  fund vs tracked index per holding — answering "am I doing well or do I need to up my
  game" without inventing data.
- A new control-plane table `benchmark_prices` and a best-effort benchmark phase on the
  daily cron; no per-workspace schema change and no snapshot, reconciliation, or net-worth
  change — consistent with **ADR 0039** (exposure) and **ADR 0040** (returns): all are
  reference/lens layers off the truth, never frozen.
- **The global inflation comparison is ungated** — it needs only existing snapshots + the
  CPI series — and ships first. The **per-holding** comparison is **double-gated** on
  **#547** (returns / TWR) and **#539 S1** (the `tracked-index` hand-entry, #541), the
  real dependencies, kept off the ungated critical path.
- **Builds on** ADR 0008 (snapshot series), the daily cron (PRD #528), and reuses the
  `tracked-index` label (ADR 0039) and TWR (ADR 0040). **Leaves untouched** ADR 0008's
  reconciliation. A missing FX layer means USD-listed index proxies need EUR-listed
  accumulating equivalents (SXR8 / EUNL …) or a per-series coverage note — a per-holding
  slice detail, not a v1 blocker.
- Sliced in PRD #546: **S0** prototype (vs-inflation UX); **S1** engine + control-plane
  catalog + INE adapter + cron phase (ungated, TDD); **S2** dashboard inflation overlay;
  **S3** MCP inflation block; **S4** per-holding engine (Stooq adapter, both variants,
  `tracked-index`→`series_id`, distributing flag) — gated on #547 + #539 S1; **S5**
  per-holding surfaces (holding detail + MCP). Backlog: more series, **per-asset-class**
  comparison (gated on #539 S0), daily cadence, clean FX for USD proxies.
