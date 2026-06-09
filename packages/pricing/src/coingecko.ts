import type { PriceProvider } from "./index";

export const coingeckoProvider: PriceProvider = {
  name: "coingecko",
  canFetch: (ctx) => Boolean(ctx.symbol),
  fetchPrice: async (ctx) => {
    const url =
      "https://api.coingecko.com/api/v3/simple/price?ids=" +
      encodeURIComponent(ctx.symbol) +
      "&vs_currencies=eur";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { eur?: number }>;
    const eur = data?.[ctx.symbol]?.eur;
    if (eur == null) return null;
    return { price: String(eur), currency: "EUR" };
  },
};
