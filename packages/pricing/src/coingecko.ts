import type { PriceProvider } from "./index";

export const coingeckoProvider: PriceProvider = {
  name: "coingecko",
  fetchPrice: async (ctx) => {
    // CoinGecko's /simple/price keys both the `ids` query and the response by
    // the lowercase coin id (e.g. "bitcoin"), so normalize the stored symbol.
    const id = ctx.symbol.trim().toLowerCase();
    const url =
      "https://api.coingecko.com/api/v3/simple/price?ids=" +
      encodeURIComponent(id) +
      "&vs_currencies=eur";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { eur?: number }>;
    const eur = data?.[id]?.eur;
    if (eur == null) return null;
    return { price: String(eur), currency: "EUR" };
  },
};
