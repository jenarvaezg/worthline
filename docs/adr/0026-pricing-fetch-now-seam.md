# The pricing seam exposes one `fetchPriceNow` that resolves, falls back, and reports the delivering source

## Context

The price seam already has a clean spine. `packages/pricing/src/registry.ts` is the single place a `PriceSource` resolves to a provider (`resolveProvider`, `registry.ts:76`) and the single place cross-provider fallback is declared as data (`fallbackChains`, `registry.ts:71`; ADR 0011). `fetchWithFallback(source, ctx)` (`registry.ts:109`) walks a source's chain and stamps `source` to whoever actually delivered the price (`registry.ts:97`). Providers themselves only fetch their own source and never route.

But that spine is only reachable through one door: `fetchAndCachePrice` (`index.ts:61`), which folds a fetch into an `AssetPrice` **cache row** (`freshnessState`, `fetchedAt`, `source`). That coupling is fine for the refresh path — `refreshStalePrices` (`refresh-stale-prices.ts:83`) selects stale rows, fetches each through a fallback-driven adapter (`resolveInvestmentPriceProvider`, `refresh-stale-prices.ts:136-147`), and returns refreshed `AssetPrice` entries. It is wrong for everyone who wants a price _right now_ and does not own a cache row. So three callers invent their own door:

1. **`refreshPricesAction` builds fake cache rows.** To force `refreshStalePrices` to fetch, it fabricates a `forcedStaleCache` with `fetchedAt: "1970-01-01T00:00:00.000Z"` and `source: "stooq"` for every asset (`apps/web/app/inversiones/actions.ts:583-591`). The epoch date and the bogus `stooq` source exist only to defeat the staleness filter. This is cache POLICY (`selectStalePrices`, `prices.ts:77`) being faked to reach fetch POLICY.

2. **Provider-symbol validation hand-rolls a provider switch.** `validateInvestmentProviderSymbol` resolves a provider with its own `switch (provider)` (`actions.ts:92-101`, `providerForValidation`), bypassing `resolveProvider`. It also has to special-case `finect`/`coingecko` out (`actions.ts:77`) and then build a throwaway `assetId`/`nowIso` `AssetPrice` via `fetchAndCachePrice` only to read its `freshnessState` (`actions.ts:80-87`). A validation wants "is there a price?", not a cache row — and it never exercises Yahoo→Stooq fallback, so a transient Yahoo miss rejects a valid symbol.

3. **Binance revalue calls CoinGecko directly.** `fetchCoinGeckoPriceEur` (`packages/pricing/src/binance-sync.ts:83-102`) reaches for `resolveProvider("coingecko").fetchPrice(...)` with a sentinel `assetId: "binance-token"` and unwraps the result by hand. It correctly avoids the cache-row layer, but it pins the provider to a literal `"coingecko"` and re-implements the unwrap/`"failed" in result` check that the seam should own — so a token price never participates in any fallback chain.

All three want the same thing the registry already computes — a price plus the source that delivered it — and none of them want a cache row. The `PriceProviderResult` (`index.ts:12`, fields `price`, `priceDate?`, `currency`, `source?`) already carries exactly that; it is just trapped behind `fetchAndCachePrice`. (`binance-history.ts:117-126`'s `market_chart/range` call is a _historical curve_ fetch, not a live point, and is deliberately out of scope here.)

## Decision

Add one **pure-fetch** entry point to the registry seam, beside the fallback policy it depends on:

```ts
// packages/pricing/src/registry.ts
export interface FetchedPrice {
  price: string; // decimal string, provider's reported quote
  currency: string; // ISO currency the quote is in
  source: PriceSource; // who actually delivered it (fallback-aware)
  priceDate?: string; // provider's own as-of date, when given
}

/**
 * Fetch a price NOW for a registered source, applying its declared fallback
 * chain. Resolves to the delivering price + source, or `null` on a total miss
 * (every link failed). Never throws — misses degrade to `null`, mirroring the
 * search seam's degrade-to-empty contract.
 */
export async function fetchPriceNow(
  source: RegisteredSource,
  ctx: PriceProviderContext,
): Promise<FetchedPrice | null>;
```

This answers the four open questions and serves all three callers:

- **Signature.** Takes `(source: RegisteredSource, ctx)` — the same low-level pair the registry already resolves — not a higher-level "descriptor". The descriptor (tier default vs explicit override) is domain policy (`defaultInvestmentPriceProvider`, `prices.ts:47`) and stays at the caller; resolving the _name_ to a provider is the registry's job, and `fetchPriceNow` is the verb for it. `async`, because every provider is `async`. Returns a **typed `FetchedPrice | null`**, never a `PriceProviderFailure` and never a thrown error: the searches degrade to `[]` (`search.ts:42,68`) and this degrades to `null`, so callers branch on one shape. A caller that needs the _reason_ a fetch failed keeps using `fetchAndCachePrice`, whose `staleReason` carries it (`index.ts:75`); `fetchPriceNow` is the "did I get a price" verb, deliberately reasonless.

- **Relationship to cached-price refresh.** `fetchPriceNow` is **pure fetch — it never touches the cache.** It does not read staleness and does not write an `AssetPrice`. The refresh path keeps owning cache policy: `refreshStalePrices` keeps `selectStalePrices` + `fetchAndCachePrice` exactly as today. The seam is layered so both refresh and fetch-now sit on the **same** fallback engine without one calling the other through the cache:
  - `fetchPriceNow(source, ctx)` = `runFallbackChain` + unwrap to `FetchedPrice | null`.
  - `fetchAndCachePrice` stays the cache-row constructor; refactored to _call_ `fetchPriceNow` internally for the fetch, then stamp `freshnessState`/`fetchedAt` (so a fetched-but-failed link still becomes a `failed` row with its reason — that branch reads the chain's last failure, see Consequences). Fallback policy thus lives in **one** function; cache policy lives only in `fetchAndCachePrice` + the refresh module. Refresh does **not** call `fetchPriceNow` directly; it keeps calling `fetchAndCachePrice` because it _needs_ the cache row.

- **Where it lives.** In `packages/pricing/src/registry.ts`, exported from `index.ts` alongside `fetchWithFallback`/`resolveProvider`. It belongs adjacent to the fallback policy it consumes, not in a new module and not in `refresh-stale-prices.ts` (which is cache-policy territory). This keeps the rule the issue demands literal: **fallback policy in the registry, cache policy in refresh.**

- **How fallbacks are exercised.** `fetchPriceNow` calls the existing `fetchWithFallback(source, ctx)` (`registry.ts:109`) and unwraps its `PriceProviderResult | Failure | null`: a usable result becomes `FetchedPrice` (with `source` already stamped by `runFallbackChain`, `registry.ts:97`); a failure or `null` becomes `null`. There is no second fallback implementation — fetch-now and refresh both walk `fallbackChains` through the same `runFallbackChain`.

The three callers collapse onto it:

- **#317 `refreshPricesAction`:** delete `forcedStaleCache` (`actions.ts:583-591`). The action no longer fabricates cache rows; it keeps using `refreshStalePrices` for the bulk persist path (refresh = cache concern). The fake-row hack vanishes because the test surface that asserted on it moves to asserting refresh selects/fetches/persists honestly.
- **#318 validation:** replace `providerForValidation`'s switch (`actions.ts:92-101`) with `fetchPriceNow(priceProvider, ctx)`, treating a non-null result as valid. Gains Yahoo→Stooq fallback for free; loses the throwaway `AssetPrice` and the bespoke `freshnessState === "fresh"` read.
- **#318 Binance revalue:** `fetchCoinGeckoPriceEur` (`binance-sync.ts:83-102`) calls `fetchPriceNow("coingecko", ctx)` and reads `.price`, dropping the hand-rolled `"failed" in result` unwrap (`binance-sync.ts:94`). Binance token prices now ride any future chain declared for `coingecko`.

## Considered options

- **A new "fetch-now" module separate from the registry** — rejected. It would either re-resolve providers (a second resolution point, defeating the registry's "single place" invariant, `registry.ts:6-7`) or import the registry anyway. Adjacency to `fallbackChains` is the whole point; a new file adds a hop without adding a boundary.

- **Put fetch-now in `refresh-stale-prices.ts`** — rejected. That module is the home of cache POLICY (TTL selection, concurrency bounding, `AssetPrice` construction). Hosting a cache-free fetch there re-tangles the two policies the issue explicitly separates, and would pull cache-flavoured imports into the validation and Binance paths.

- **Return `PriceProviderResult | PriceProviderFailure | null` verbatim** (expose the raw three-state) — rejected for the public verb. It re-exports the provider's internal failure shape and forces every caller to repeat the `isProviderFailure` discrimination (the exact ceremony `binance-sync.ts:94` already duplicates). Collapsing to `FetchedPrice | null` matches the search seam's degrade-to-empty contract and keeps `source` non-optional in the success case (the registry has always stamped it, so the optional `source?` of `PriceProviderResult` is an artifact of the provider layer, not a real absence).

- **Have refresh call `fetchPriceNow` and write the cache around it** — deferred, not adopted now. Tempting (one fetch path), but `fetchAndCachePrice` must still construct the `failed` row with its `staleReason` (`index.ts:75`), which `fetchPriceNow` deliberately discards. The clean layering is: `fetchAndCachePrice` calls `fetchPriceNow` for the _success_ fetch and consults the chain's last failure for the _reason_ — refresh keeps calling `fetchAndCachePrice`, not `fetchPriceNow`, so the cache contract has exactly one owner.

- **A higher-level `fetchPriceFor(asset)` descriptor entry point** — rejected. It would pull `defaultInvestmentPriceProvider` tier logic (`prices.ts:47`) into the pricing package and couple the seam to the investment asset shape. The descriptor→source decision is a thin caller concern; keeping `fetchPriceNow` at `(source, ctx)` keeps the pricing package ignorant of liquidity tiers.

## Consequences

- **The fake cache row becomes unrepresentable as an idiom.** No caller needs an epoch `fetchedAt` or a bogus `source` to reach a fetch (`actions.ts:586,589`); fetching now is a named verb, not a side effect of defeating staleness.
- **One fallback engine, two doors.** `fetchPriceNow` (cache-free) and `fetchAndCachePrice` (cache-row) both route through `runFallbackChain`. Adding or reordering a chain in `fallbackChains` (`registry.ts:71`) affects validation, Binance revalue, and refresh identically — the ADR 0011 invariant holds across all callers, not just refresh.
- **Validation and Binance gain fallback for free**, and the Binance path stops pinning `"coingecko"` as a literal in two places. The provider-specific `switch` (`actions.ts:92-101`) is deleted, satisfying #318's "no provider-specific switch" criterion.
- **A reason-carrying path still exists.** Callers needing _why_ a fetch failed (the refresh banner, #137) keep `fetchAndCachePrice`/`staleReason`. `fetchPriceNow` is intentionally reasonless; if a future caller needs the reason without the cache row, expose a `fetchPriceNowDetailed` returning the raw three-state rather than overloading the simple verb. The refactor of `fetchAndCachePrice` must keep surfacing the chain's **last failure reason** (`runFallbackChain` already returns it verbatim, `registry.ts:102`), so splitting the success unwrap into `fetchPriceNow` must not drop that — the `failed`-row branch reads `fetchWithFallback`'s raw return, not `fetchPriceNow`'s collapsed `null`.
- **No new domain noun.** "Fetch now", "fallback chain", "delivering source", and "price cache" already name these concepts (ADR 0011, `registry.ts`, `prices.ts`). `FetchedPrice` is an implementation type for the cache-free result, parallel to `SymbolCandidate` (`search.ts:10`), not a new term in CONTEXT.md.
- **Test surface.** `fetchPriceNow` is unit-testable with a stubbed `fallbackChains`/provider, no cache fixtures. The #317 tests that assert on `forcedStaleCache` move to asserting honest stale-select + persist, shrinking the action's test toward parse-and-delegate.
