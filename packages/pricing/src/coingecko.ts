import { fetchHttpWithRetry } from "./fetch-with-retry";
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

/**
 * Per-request headers for a CoinGecko call. When `WORTHLINE_COINGECKO_API_KEY` is
 * set (a FREE "demo" key) every request carries the `x-cg-demo-api-key` header,
 * which lifts the shared rate limit from the public unauthenticated tier (~5-15
 * req/min, burst-throttled) to the demo tier (~30 req/min). That headroom is what
 * keeps a Binance sync's history-range calls alive: they run right after the
 * live-price burst and, on the public tier, 429 — which the history fetch swallows
 * to an empty series, silently zeroing the reconstructed monthly history (so the
 * holding lands only on today, "as if just bought"). Absent → the unauthenticated
 * tier (unchanged default). Read per call so a test/deploy can set it after import;
 * shared with the history-range fetch in `binance-history.ts`.
 */
export function coingeckoHeaders(): Record<string, string> {
  const key = process.env.WORTHLINE_COINGECKO_API_KEY?.trim();
  return key ? { "x-cg-demo-api-key": key } : {};
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
    const res = await fetchHttpWithRetry(url, {
      headers: coingeckoHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { eur?: number }>;
    const eur = data?.[id]?.eur;
    if (eur == null) return null;
    return { price: String(eur), currency: "EUR" };
  },
};
