# Multi-provider pricing: Yahoo primary, Stooq fallback, Finect for pensions

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
For Finect, the symbol is the plan code (e.g. `N5394`).

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

- **Yahoo replaces Stooq** — rejected: Stooq is more reliable for European
  ETFs; keeping it as fallback costs nothing.
- **Inferred provider** (no explicit field) — rejected: fragile heuristics
  (e.g. a 5-letter ticker starting with N could be a stock or a plan code).
- **Separate `finect_code` column** — rejected: `provider_symbol` already
  means "the key sent to the provider", so a Finect plan code fits naturally.
- **ISIN-based resolution** — rejected: many funds and all pension plans
  cannot be resolved from ISIN to price via free APIs.
- **Per-provider TTL** (72h for Finect) — rejected: 24h for all keeps the
  model simple; re-fetching a stale NAV is cheap and returns the same value.
