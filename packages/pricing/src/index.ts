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

export interface PriceProvider {
  name: PriceSource;
  canFetch(ctx: PriceProviderContext): boolean;
  fetchPrice(ctx: PriceProviderContext): Promise<PriceProviderResult | null>;
}

export async function fetchAndCachePrice(
  provider: PriceProvider,
  ctx: PriceProviderContext,
): Promise<AssetPrice> {
  try {
    const result = await provider.fetchPrice(ctx);
    if (!result) {
      return {
        assetId: ctx.assetId,
        currency: ctx.currency,
        price: "0",
        source: provider.name,
        fetchedAt: ctx.nowIso,
        freshnessState: "failed",
        staleReason: "No price returned",
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
export { finectProvider } from "./finect";
export { stooqProvider } from "./stooq";
export { yahooProvider } from "./yahoo";
export { refreshStalePrices } from "./refresh-stale-prices";
export type {
  InvestmentAssetRef,
  RefreshStalePricesResult,
} from "./refresh-stale-prices";
