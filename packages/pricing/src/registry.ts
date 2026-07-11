/**
 * The price-provider routing + fallback POLICY (issue #243, ADR 0011).
 *
 * This is the single place a `PriceSource` resolves to a `PriceProvider`, and
 * the single place the cross-provider fallback chains are declared as DATA.
 * Providers themselves only fetch from their own source; how requests route and
 * which source rescues a miss lives here, behind the seam.
 *
 * Adding a provider = one `providerRegistry` entry. Reordering or extending a
 * fallback = one `fallbackChains` edit. Neither requires touching a provider
 * body or a hand-written routing switch.
 */

import { coingeckoProvider } from "./coingecko";
import { ecbProvider } from "./ecb";
import { finectProvider } from "./finect";
import {
  formatFallbackChainFailure,
  isProviderFailure,
  type PriceProvider,
  type PriceProviderContext,
  type PriceProviderFailure,
  type PriceProviderResult,
  type PriceSource,
} from "./index";
import { stooqProvider } from "./stooq";
import { yahooProvider } from "./yahoo";

/**
 * Every fetching provider, keyed by the `PriceSource` it serves. `manual` and
 * `numista` are price sources with no network provider (manual quotes and the
 * coin-collection valuation are produced elsewhere), so they are absent here.
 *
 * Defined with getters so each provider binding is read lazily (live binding) at
 * lookup time rather than captured at module-eval time. This keeps the registry
 * robust to the import cycle it sits in: `yahoo`/`numista-valuation` resolve other
 * providers FROM this registry (issue #243), so they import this module while it
 * is still initialising — a plain object literal would snapshot some bindings as
 * `undefined`.
 */
export const providerRegistry = {
  get yahoo() {
    return yahooProvider;
  },
  get stooq() {
    return stooqProvider;
  },
  get ecb() {
    return ecbProvider;
  },
  get coingecko() {
    return coingeckoProvider;
  },
  get finect() {
    return finectProvider;
  },
} satisfies Partial<Record<PriceSource, PriceProvider>>;

/** The `PriceSource` values that resolve to a fetching provider. */
export type RegisteredSource = keyof typeof providerRegistry;

/**
 * Declarative TRUE fallback chains: when the primary source returns no usable
 * price, walk these sources in order and take the first success. This is the
 * ADR 0011 Yahoo→Stooq fallback expressed as data — reordering or extending a
 * chain is an edit here, not in a provider body.
 *
 * Currency CONVERSIONS (Yahoo→ECB FX, metal-spot Stooq×ECB) are NOT fallbacks
 * and deliberately do not live here: they are composition pipelines where every
 * leg must succeed, modelled inside their own helpers.
 */
export const fallbackChains: Partial<Record<RegisteredSource, readonly PriceSource[]>> = {
  yahoo: ["stooq"],
};

/**
 * A price plus the source that actually delivered it, with no cache-row baggage
 * (ADR 0026). The cache-free counterpart to the `AssetPrice` that
 * `fetchAndCachePrice` builds; parallel to `SymbolCandidate` from the search
 * seam — an implementation type, not a new domain noun.
 */
export interface FetchedPrice {
  /** Decimal string, the provider's reported quote. */
  price: string;
  /** ISO currency the quote is in. */
  currency: string;
  /** Who actually delivered it (fallback-aware). */
  source: PriceSource;
  /** The provider's own as-of date, when given. */
  priceDate?: string;
}

/** Resolve a source to its registered provider (the single resolution point). */
export function resolveProvider(source: RegisteredSource): PriceProvider {
  return providerRegistry[source];
}

/**
 * Fetch a price NOW for a registered source, applying its declared fallback
 * chain (ADR 0026). Resolves to the delivering price + source, or `null` on a
 * total miss (every link failed or returned no data). Never throws — misses
 * degrade to `null`, mirroring the search seam's degrade-to-empty contract.
 *
 * This is the pure-fetch door onto the same fallback engine the refresh path
 * uses: it calls `fetchWithFallback` and collapses its three-state
 * (`PriceProviderResult | PriceProviderFailure | null`) to `FetchedPrice | null`.
 * It deliberately discards the failure REASON — callers needing *why* a fetch
 * failed keep `fetchAndCachePrice`/`staleReason`. It never touches the cache.
 */
export async function fetchPriceNow(
  source: RegisteredSource,
  ctx: PriceProviderContext,
): Promise<FetchedPrice | null> {
  return unwrapFetched(await fetchWithFallback(source, ctx), source);
}

/**
 * Collapse a chain's three-state result into a `FetchedPrice | null`, stamping
 * the delivering `source`. The single success-unwrap shared by `fetchPriceNow`
 * (cache-free) and `fetchAndCachePrice`'s fresh-row construction, so both doors
 * onto the fallback engine produce an identical success shape (ADR 0026).
 *
 * `runFallbackChain` always stamps `source` on a rescue; a primary's own success
 * leaves it unset, so the resolved source name is the deliverer in that case.
 */
export function unwrapFetched(
  result: PriceProviderResult | PriceProviderFailure | null,
  source: PriceSource,
): FetchedPrice | null {
  if (!isUsable(result)) return null;
  return {
    price: result.price,
    currency: result.currency,
    source: result.source ?? source,
    ...(result.priceDate ? { priceDate: result.priceDate } : {}),
  };
}

/**
 * Try `primary`, then walk `fallbacks` in order, returning the FIRST success.
 * A rescuing fallback stamps `source` to whoever actually delivered the price
 * (so a Stooq rescue records `"stooq"`). When every link fails, a composite
 * reason names each provider's miss (issue #925).
 */
export async function runFallbackChain(
  primary: PriceProvider,
  fallbacks: readonly PriceProvider[],
  ctx: PriceProviderContext,
): Promise<PriceProviderResult | PriceProviderFailure | null> {
  const attempts: Array<{
    source: PriceSource;
    result: PriceProviderResult | PriceProviderFailure | null;
  }> = [];

  let last = await safeFetch(primary, ctx);
  attempts.push({ source: primary.name, result: last });
  if (isUsable(last)) return last;

  for (const provider of fallbacks) {
    const result = await safeFetch(provider, ctx);
    attempts.push({ source: provider.name, result });
    if (isUsable(result)) {
      return { ...result, source: provider.name };
    }
    last = result;
  }

  return { failed: true, reason: formatFallbackChainFailure(attempts) };
}

/**
 * Fetch a source applying its declared fallback chain (the policy entry point
 * for the refresh path). Sources with no declared chain are fetched alone.
 */
export async function fetchWithFallback(
  source: RegisteredSource,
  ctx: PriceProviderContext,
): Promise<PriceProviderResult | PriceProviderFailure | null> {
  const fallbacks = (fallbackChains[source] ?? []).map((name) =>
    resolveProvider(name as RegisteredSource),
  );
  return runFallbackChain(resolveProvider(source), fallbacks, ctx);
}

function isUsable(
  result: PriceProviderResult | PriceProviderFailure | null,
): result is PriceProviderResult {
  return result !== null && !isProviderFailure(result);
}

/** A provider should never reject (callers degrade misses), but be defensive. */
async function safeFetch(
  provider: PriceProvider,
  ctx: PriceProviderContext,
): Promise<PriceProviderResult | PriceProviderFailure | null> {
  try {
    return await provider.fetchPrice(ctx);
  } catch (err) {
    return { failed: true, reason: err instanceof Error ? err.message : "Unknown error" };
  }
}
