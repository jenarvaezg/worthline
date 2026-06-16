import type { PriceProvider } from "./index";

/**
 * The CoinGecko API origin (including `/api/v3`). Defaults to the real host;
 * overridable via `WORTHLINE_COINGECKO_BASE_URL` so an e2e run (or a self-host
 * proxy) can point the price + history fetches at a local stub server. Read per
 * call (not a module const) so a test can set the env after import. Shared by the
 * live-price provider here and the history-range fetch in `binance-history.ts`.
 */
export function coingeckoBaseUrl(): string {
  return process.env.WORTHLINE_COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3";
}

export const coingeckoProvider: PriceProvider = {
  name: "coingecko",
  fetchPrice: async (ctx) => {
    // CoinGecko's /simple/price keys both the `ids` query and the response by
    // the lowercase coin id (e.g. "bitcoin"), so normalize the stored symbol.
    const id = ctx.symbol.trim().toLowerCase();
    const url =
      `${coingeckoBaseUrl()}/simple/price?ids=` +
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
