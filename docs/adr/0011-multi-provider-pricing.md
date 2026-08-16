# Multi-provider pricing: Yahoo primary, Finect for pensions

> **Amended 2026-07-31 (#1354): Stooq is retired.** It deployed anti-bot
> protection and now answers EVERY symbol with an HTML error page (verified for
> `eurusd`, `^spx`, `aapl.us`), so the fallback rescued nothing while doubling the
> latency of each miss and writing a second provider's name into every failure
> reason. `stooqProvider` is deleted, the registry no longer lists it, and
> `fallbackChains` is empty: Yahoo misses are now honest misses. `"stooq"` stays
> in the `PriceSource`/`InvestmentPriceProvider` vocabulary because stored rows
> carry it; those rows route to `retiredPriceProvider`, which fetches nothing and
> fails TRANSIENTLY so the last known price survives as stale with an actionable
> reason ("asigna un símbolo de Yahoo"). The sections below describe the
> pre-amendment design; the routing/seam reasoning still holds.

> **Amended 2026-08-16 (#1357): Finect serves funds too, and quotes carry their
> own currency.** The provider read the NAV by scraping the first
> `<digits> €|EUR` out of the flattened page, which matched URL-encoded copy
> (`%20de%20Europa` → a 20 € NAV) and hardcoded `currency: "EUR"` on every quote.
> It now reads the page's `application/ld+json` offer — price plus
> `priceCurrency` — and converts a non-EUR NAV through the ECB rate (#1065),
> failing rather than passing dollars off as euros. Two consequences for the
> sections below: a Finect **symbol** is the product slug (a pension code
> `N5394-Myinvestor…` OR an ISIN `IE00BDZVHT63-Fidelity…`), not the bare plan
> code, and Finect covers Spanish investment **funds** as well as pension plans —
> `/planes-pensiones/` 301-redirects to `/fondos-inversion/`, so one base URL
> still serves both. The routing/seam reasoning is unchanged.

The app started with a single market provider (Stooq). To cover pension plan
NAVs (which Stooq cannot serve) and improve market ticker coverage, we added
two providers: **Yahoo Finance** for market prices and **Finect** for Spanish
pension plan NAVs.

## Routing

Each investment carries an explicit `priceProvider` field (`"yahoo"`, `"stooq"`,
`"finect"`). Defaults are tier-aware: `retirement` → `"finect"`, everything
else → `"yahoo"`. The user can override at creation or edit time.

## Fallback

When the primary provider is Yahoo and the fetch fails, the system falls back
to Stooq silently. The `asset_price_cache.source` records the provider that
actually delivered the price. No warning is raised unless **all** providers
fail for that asset.

The fallback and routing are POLICY behind the provider seam, not provider-body
logic (issue #243): a single `providerRegistry` is the one place a source name
resolves to a provider, and `fallbackChains` declares the Yahoo→Stooq rescue as
data that `fetchWithFallback` runs (currency conversions stay composition
pipelines, not fallbacks). Adding a provider is one registry entry; reordering a
chain is one data edit. The seam dropped the never-consulted `canFetch`
pre-check: a provider already signals inability by returning `null`/a failure,
so the gate was redundant ceremony.

## Symbol format

The `provider_symbol` field uses Yahoo-format tickers as canonical
(e.g. `SAN.MC`, `VUSA.L`). Stooq normalises internally (lowercasing, etc.).
For Finect, the symbol is the plan code (e.g. `N5394`) — since #1357, the full
product slug (`N5394-Myinvestor_indexado_sp_500_pp`,
`IE00BDZVHT63-Fidelity_msci_pac_ex_jpn_idx_usd_p_acc`); a bare code is resolved
to its slug through Finect's public plans API before use.

## Validation

On investment create/edit, the system validates that the provider symbol
resolves to a real asset by performing a test fetch. Invalid symbols are
rejected at the form level.

## ISIN

Stored as reference metadata only. Not used for price lookups — the provider
symbol is the sole key.

## TTL

All providers share a 24-hour TTL, consistent with the existing per-source
TTL table (ADR 0007). Pension plan NAVs are published with 1–2 day lag but
the 24-hour TTL is kept for simplicity; a stale NAV simply triggers a
re-fetch that returns the same value until the gestora publishes a new one.

## Considered options

- **Yahoo replaces Stooq** — rejected in 2025, then FORCED in 2026 (#1354): the
  provider died to anti-bot protection, so the choice was made for us. The
  "costs nothing" argument was wrong in one way worth recording: a dead fallback
  is not free, because its failures are indistinguishable from real ones until
  someone reads a `stale_reason` closely.
- **Auto-migrating stored `stooq` rows to `yahoo`** (#1354) — rejected: the
  symbols are not interchangeable (`aapl.us` → `AAPL`, but `4gld.de` → `4GLD.DE`),
  so a bulk rewrite would silently point holdings at wrong or non-existent
  tickers. The retirement is reported per holding and the user reassigns.
- **Inferred provider** (no explicit field) — rejected: fragile heuristics
  (e.g. a 5-letter ticker starting with N could be a stock or a plan code).
- **Separate `finect_code` column** — rejected: `provider_symbol` already
  means "the key sent to the provider", so a Finect plan code fits naturally.
- **ISIN-based resolution** — rejected: many funds and all pension plans
  cannot be resolved from ISIN to price via free APIs.
- **Per-provider TTL** (72h for Finect) — rejected: 24h for all keeps the
  model simple; re-fetching a stale NAV is cheap and returns the same value.
