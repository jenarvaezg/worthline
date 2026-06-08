import type { CurrencyCode, DecimalString } from "@worthline/contracts";

export type PriceFreshness = "fresh" | "cached" | "stale" | "manual" | "failed";

export interface PriceLookupInput {
  assetId: string;
  currency: CurrencyCode;
  providerSymbol?: string;
}

export interface PriceQuote {
  assetId: string;
  currency: CurrencyCode;
  fetchedAt: string;
  freshness: PriceFreshness;
  price: DecimalString;
  pricedAt: string;
  providerId: string;
}

export interface PriceProvider {
  id: string;
  label: string;
  getLatestPrice(input: PriceLookupInput): Promise<PriceQuote | null>;
  supports(input: PriceLookupInput): boolean;
}

export const manualFallbackProvider: PriceProvider = {
  id: "manual",
  label: "Manual fallback",
  getLatestPrice: async () => null,
  supports: () => false,
};
