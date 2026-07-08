import type { AssetPrice, InvestmentPriceProvider, PriceSource } from "@worthline/domain";

import { TRANSIENT_HTTP_STATUSES } from "./fetch-with-retry";
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
  currencyMismatch: (providerCurrency: string, assetCurrency: string) =>
    `La divisa del proveedor (${providerCurrency}) no coincide con la del activo (${assetCurrency})`,
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

export interface FetchAndCacheOptions {
  /** Prior cache row — its good price is preserved on a transient failure. */
  prior?: AssetPrice | null;
}

function hasGoodCachedPrice(prior: AssetPrice): boolean {
  return prior.price !== "0";
}

/**
 * Whether a fetch miss is transient (retry/backoff candidate) vs a permanent
 * symbol/data problem. Transient failures preserve the prior good price.
 */
export function isTransientFetchFailure(
  result: PriceProviderResult | PriceProviderFailure | null,
  reason: string,
): boolean {
  if (result === null) return true;
  if (!isProviderFailure(result)) return false;

  if (result.reason === PRICE_FAILURE_REASONS.symbolNotFound) return false;
  if (result.reason === PRICE_FAILURE_REASONS.noQuote) return false;
  if (result.reason.startsWith("La divisa del proveedor")) return false;

  const httpMatch = result.reason.match(/error \((\d+)\)/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 404) return false;
    return TRANSIENT_HTTP_STATUSES.has(status) || status >= 500;
  }

  return reason !== PRICE_FAILURE_REASONS.symbolNotFound;
}

export async function fetchAndCachePrice(
  provider: PriceProvider,
  ctx: PriceProviderContext,
  options: FetchAndCacheOptions = {},
): Promise<AssetPrice> {
  const { prior } = options;
  try {
    // Fetch once; `fetched` is the cache-free success unwrap shared with
    // `fetchPriceNow` (ADR 0026). The `failed`-row branch reads the RAW result
    // for its reason, which `fetchPriceNow` deliberately collapses to `null`.
    const result = await provider.fetchPrice(ctx);
    const fetched = unwrapFetched(result, provider.name);
    if (!fetched) {
      const reason = isProviderFailure(result) ? result.reason : "No price returned";
      if (prior && hasGoodCachedPrice(prior) && isTransientFetchFailure(result, reason)) {
        return {
          ...prior,
          freshnessState: "stale",
          staleReason: reason,
          fetchedAt: ctx.nowIso,
        };
      }
      return {
        assetId: ctx.assetId,
        currency: ctx.currency,
        price: "0",
        source: provider.name,
        fetchedAt: ctx.nowIso,
        freshnessState: "failed",
        staleReason: reason,
      };
    }
    if (fetched.currency !== ctx.currency) {
      const mismatchReason = PRICE_FAILURE_REASONS.currencyMismatch(
        fetched.currency,
        ctx.currency,
      );
      if (prior && hasGoodCachedPrice(prior)) {
        return {
          ...prior,
          freshnessState: "stale",
          staleReason: mismatchReason,
          fetchedAt: ctx.nowIso,
        };
      }
      return {
        assetId: ctx.assetId,
        currency: ctx.currency,
        price: "0",
        source: fetched.source,
        fetchedAt: ctx.nowIso,
        freshnessState: "failed",
        staleReason: mismatchReason,
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
    const reason = err instanceof Error ? err.message : "Unknown error";
    if (prior && hasGoodCachedPrice(prior)) {
      return {
        ...prior,
        freshnessState: "stale",
        staleReason: reason,
        fetchedAt: ctx.nowIso,
      };
    }
    return {
      assetId: ctx.assetId,
      currency: ctx.currency,
      price: "0",
      source: provider.name,
      fetchedAt: ctx.nowIso,
      freshnessState: "failed",
      staleReason: reason,
    };
  }
}

export { searchSymbols } from "./search";
export type { SymbolCandidate } from "./search";
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
} from "./numista-valuation";
export type {
  NumistaSyncDeps,
  PositionDraft,
  RevalueDeps,
  RevalueOptions,
  RevaluedPosition,
  RevaluePosition,
} from "./numista-valuation";
export { getAccountSnapshots, getAllBalances } from "./binance";
export type {
  BinanceAccountSnapshot,
  BinanceCredentials,
  BinanceRequestDeps,
  BinanceWalletBalance,
} from "./binance";
export { resolveCoinGeckoId, isBinanceFiatEur } from "./binance-symbols";
export {
  fetchCoinGeckoLogos,
  fetchCoinGeckoPriceEur,
  syncBinanceAccount,
} from "./binance-sync";
export type { BinanceSyncDeps, TokenPositionDraft } from "./binance-sync";
export { fetchCoinGeckoHistoryEur, reconstructBinanceHistory } from "./binance-history";
export type {
  CoinGeckoHistoryResult,
  ReconstructBinanceHistoryDeps,
} from "./binance-history";
export { rungForWallet } from "./binance-rung";
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
export { fetchSpanishCpi, INE_SPANISH_CPI_TABLE_ID } from "./ine-cpi";
export type { BenchmarkPricePoint } from "./ine-cpi";
export { fetchStooqMonthlyBenchmark } from "./stooq-benchmark";
