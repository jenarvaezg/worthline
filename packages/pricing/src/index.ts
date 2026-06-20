import type { AssetPrice, InvestmentPriceProvider, PriceSource } from "@worthline/domain";

import { unwrapFetched } from "./registry";

export type { AssetPrice, InvestmentPriceProvider, PriceSource };

export interface PriceProviderContext {
  assetId: string;
  symbol: string;
  currency: string;
  nowIso: string;
}

export interface PriceProviderResult {
  price: string;
  priceDate?: string;
  currency: string;
  source?: PriceSource;
}

/**
 * A provider failure carrying a human-readable reason (issue #137). Lets a
 * provider distinguish "symbol resolved but no parseable quote" / "HTTP error"
 * from the generic `null` ("no data"), so the refresh banner can tell the user
 * *why* a symbol failed (wrong symbol vs transient outage).
 */
export interface PriceProviderFailure {
  failed: true;
  reason: string;
}

/** Standard, localized failure reasons shared across HTML/web providers. */
export const PRICE_FAILURE_REASONS = {
  symbolNotFound: "Símbolo no encontrado en el proveedor",
  noQuote: "El proveedor no devolvió cotización",
  httpError: (status: number) => `El proveedor respondió con un error (${status})`,
} as const;

/**
 * A price provider behind the multi-provider seam (ADR 0011). A provider only
 * knows how to fetch from its own source; routing and fallback are decided by
 * policy (see `./registry` — `providerRegistry`, `fallbackChains`,
 * `fetchWithFallback`), not by the provider body.
 *
 * There is intentionally no `canFetch` pre-check (issue #243): it was never
 * consulted on the refresh path, and a provider already signals its inability
 * by returning `null` / a `PriceProviderFailure` from `fetchPrice`. A redundant
 * gate would only add ceremony and a second place to keep in sync.
 */
export interface PriceProvider {
  name: PriceSource;
  fetchPrice(
    ctx: PriceProviderContext,
  ): Promise<PriceProviderResult | PriceProviderFailure | null>;
}

export function isProviderFailure(
  result: PriceProviderResult | PriceProviderFailure | null,
): result is PriceProviderFailure {
  return result !== null && "failed" in result && result.failed === true;
}

export async function fetchAndCachePrice(
  provider: PriceProvider,
  ctx: PriceProviderContext,
): Promise<AssetPrice> {
  try {
    // Fetch once; `fetched` is the cache-free success unwrap shared with
    // `fetchPriceNow` (ADR 0026). The `failed`-row branch reads the RAW result
    // for its reason, which `fetchPriceNow` deliberately collapses to `null`.
    const result = await provider.fetchPrice(ctx);
    const fetched = unwrapFetched(result, provider.name);
    if (!fetched) {
      return {
        assetId: ctx.assetId,
        currency: ctx.currency,
        price: "0",
        source: provider.name,
        fetchedAt: ctx.nowIso,
        freshnessState: "failed",
        staleReason: isProviderFailure(result) ? result.reason : "No price returned",
      };
    }
    return {
      assetId: ctx.assetId,
      currency: fetched.currency,
      price: fetched.price,
      source: fetched.source,
      fetchedAt: ctx.nowIso,
      freshnessState: "fresh",
      ...(fetched.priceDate ? { priceDate: fetched.priceDate } : {}),
    };
  } catch (err) {
    return {
      assetId: ctx.assetId,
      currency: ctx.currency,
      price: "0",
      source: provider.name,
      fetchedAt: ctx.nowIso,
      freshnessState: "failed",
      staleReason: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export { coingeckoProvider } from "./coingecko";
export { ecbProvider } from "./ecb";
export { finectProvider, resolveFinectPlan } from "./finect";
export { searchCoinGeckoSymbols, searchSymbols, searchYahooSymbols } from "./search";
export type { SymbolCandidate } from "./search";
export { stooqProvider } from "./stooq";
export { yahooProvider } from "./yahoo";
export {
  fallbackChains,
  fetchPriceNow,
  fetchWithFallback,
  providerRegistry,
  resolveProvider,
  runFallbackChain,
} from "./registry";
export type { FetchedPrice, RegisteredSource } from "./registry";
export { refreshStalePrices } from "./refresh-stale-prices";
export {
  getCollectedItems,
  getPrices,
  getTypeDetail,
  isTokenValid,
  mapCollectedItem,
  mintNumistaToken,
  numismaticEstimateMinor,
} from "./numista";
export type {
  CollectedItemDraft,
  NumistaCollectedItem,
  NumistaCredentials,
  NumistaPriceEntry,
  NumistaPrices,
  NumistaToken,
  NumistaTypeDetail,
} from "./numista";
export { metalValueMinor, parseComposition, STOOQ_METAL_SYMBOL } from "./metal";
export type { MetalKind, MetalValueInput, ParsedComposition } from "./metal";
export { COIN_VALUE_TTL_DAYS, coinValuation, isNumismaticStale } from "./coin-valuation";
export type {
  CandidateValuation,
  CoinValuationInput,
  CoinValueResult,
  NumismaticValuation,
} from "./coin-valuation";
export {
  NUMISMATIC_TTL_DAYS,
  fetchMetalSpotEur,
  refreshCoinValuations,
  syncNumistaCollection,
} from "./adapters/numista-valuation";
export type {
  NumistaSyncDeps,
  PositionDraft,
  RevalueDeps,
  RevalueOptions,
  RevaluedPosition,
  RevaluePosition,
} from "./adapters/numista-valuation";
export {
  getAccountSnapshots,
  getAllBalances,
  getFlexibleEarnBalances,
  getFundingBalances,
  getLockedEarnBalances,
  getSpotBalances,
  signQuery,
} from "./binance";
export type {
  BinanceAccountSnapshot,
  BinanceCredentials,
  BinanceRequestDeps,
  BinanceWalletBalance,
} from "./binance";
export { resolveCoinGeckoId } from "./binance-symbols";
export { fetchCoinGeckoPriceEur, syncBinanceAccount } from "./binance-sync";
export type { BinanceSyncDeps, TokenPositionDraft } from "./binance-sync";
export { fetchCoinGeckoHistoryEur, reconstructBinanceHistory } from "./binance-history";
export type { ReconstructBinanceHistoryDeps } from "./binance-history";
export { coingeckoHistoricalSource, parsePriceCsv } from "./historical-price-source";
export type {
  HistoricalPriceSeries,
  HistoricalPriceSource,
} from "./historical-price-source";
export type {
  InvestmentAssetRef,
  RefreshOptions,
  RefreshStalePricesResult,
} from "./refresh-stale-prices";
export { numistaAdapter } from "./adapters/numista";
export type { NumistaCreds } from "./adapters/numista";
export { binanceAdapter, rungForWallet } from "./adapters/binance";
export type { BinanceCreds } from "./adapters/binance";
export { adapterForTag } from "./adapters/registry";
export type { SourceAdapterMetadata } from "./adapters/registry";
export type {
  ConnectedSourceAdapter,
  HistoryContext,
  PositionDraft as AdapterPositionDraft,
  PositionValuationUpdate as AdapterPositionValuationUpdate,
  RevalueContext,
  RevaluePositionInput,
  SourceHistory,
  SyncContext,
} from "./adapters/types";
