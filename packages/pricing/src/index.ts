import type { AssetPrice, InvestmentPriceProvider, PriceSource } from "@worthline/domain";

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

export interface PriceProvider {
  name: PriceSource;
  canFetch(ctx: PriceProviderContext): boolean;
  fetchPrice(
    ctx: PriceProviderContext,
  ): Promise<PriceProviderResult | PriceProviderFailure | null>;
}

function isProviderFailure(
  result: PriceProviderResult | PriceProviderFailure | null,
): result is PriceProviderFailure {
  return result !== null && "failed" in result && result.failed === true;
}

export async function fetchAndCachePrice(
  provider: PriceProvider,
  ctx: PriceProviderContext,
): Promise<AssetPrice> {
  try {
    const result = await provider.fetchPrice(ctx);
    if (!result || isProviderFailure(result)) {
      return {
        assetId: ctx.assetId,
        currency: ctx.currency,
        price: "0",
        source: provider.name,
        fetchedAt: ctx.nowIso,
        freshnessState: "failed",
        staleReason: result ? result.reason : "No price returned",
      };
    }
    return {
      assetId: ctx.assetId,
      currency: result.currency,
      price: result.price,
      source: result.source ?? provider.name,
      fetchedAt: ctx.nowIso,
      freshnessState: "fresh",
      ...(result.priceDate ? { priceDate: result.priceDate } : {}),
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
export { searchSymbols, searchYahooSymbols } from "./search";
export type { SymbolCandidate } from "./search";
export { stooqProvider } from "./stooq";
export { yahooProvider } from "./yahoo";
export { refreshStalePrices } from "./refresh-stale-prices";
export type {
  InvestmentAssetRef,
  RefreshStalePricesResult,
} from "./refresh-stale-prices";
