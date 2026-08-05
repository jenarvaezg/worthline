/**
 * «Does this symbol resolve?», and the provider policy of which symbols block a
 * save at all. Extracted from the editing action (#1349) because the assistant's
 * identity fill needs the SAME answer: two copies of «finect and coingecko do not
 * block, a retired provider cannot confirm anything» would drift, and the second
 * copy would be the one nobody remembers to update when a provider is retired.
 *
 * The resolved quote rides along so the caller can say what assigning the symbol
 * WOULD do to the valuation (#1329) without a second provider round-trip; `null`
 * means «no quote in hand», the normal case for the providers deliberately not
 * validated on save.
 */

import { priceSourceLabel } from "@web/price-source-label";
import type { InvestmentPriceProvider, LiquidityTier } from "@worthline/domain";
import {
  defaultInvestmentPriceProvider,
  isRetiredInvestmentPriceProvider,
} from "@worthline/domain";
import { fetchPriceNow } from "@worthline/pricing";

export type ProviderSymbolCheck =
  | { ok: false; error: string }
  | { ok: true; quotedPricePerUnit: string | null };

export async function validateInvestmentProviderSymbol(input: {
  assetId: string;
  currency: string;
  liquidityTier: LiquidityTier;
  nowIso: string;
  priceProvider?: InvestmentPriceProvider | undefined;
  providerSymbol?: string | undefined;
}): Promise<ProviderSymbolCheck> {
  if (!input.providerSymbol) return { ok: true, quotedPricePerUnit: null };

  const priceProvider =
    input.priceProvider ?? defaultInvestmentPriceProvider(input.liquidityTier);

  // Finect NAVs can lag or disappear temporarily; per issue #106, Finect
  // validation is non-blocking at save time. CoinGecko (crypto, #151) is treated
  // the same — its symbols are validated on price refresh, not at save. This is
  // domain policy (which providers block on save), not the provider-resolution
  // routing the registry now owns via `fetchPriceNow`.
  if (priceProvider === "finect" || priceProvider === "coingecko") {
    return { ok: true, quotedPricePerUnit: null };
  }

  // A retired provider (Stooq, #1354) can no longer confirm anything, and blocking
  // here would refuse an edit that has nothing to do with the symbol — a legacy
  // holding could not even be renamed. It saves; the refresh pass is what reports
  // the retirement, with an actionable reason in salud de datos.
  if (isRetiredInvestmentPriceProvider(priceProvider)) {
    return { ok: true, quotedPricePerUnit: null };
  }

  // Route validation through the pricing seam (ADR 0026): a non-null price means
  // the symbol resolves, applying whatever fallback chain the registry declares,
  // and dropping the bespoke provider switch + the throwaway cache-row read.
  const price = await fetchPriceNow(priceProvider, {
    assetId: input.assetId,
    currency: input.currency,
    nowIso: input.nowIso,
    symbol: input.providerSymbol,
  });

  // A non-EUR quote validates the symbol but must not be quoted back as euros:
  // the caller prints it next to a euro figure (#1329).
  if (price) {
    return {
      ok: true,
      quotedPricePerUnit: price.currency === "EUR" ? price.price : null,
    };
  }

  return {
    error: `El símbolo no existe en ${priceSourceLabel(priceProvider)}.`,
    ok: false,
  };
}
