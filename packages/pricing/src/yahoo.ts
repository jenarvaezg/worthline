import type { PriceProvider } from "./index";
import { ecbProvider } from "./ecb";
import { stooqProvider } from "./stooq";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string;
        regularMarketPrice?: number;
      };
    }>;
  };
}

export const yahooProvider: PriceProvider = {
  name: "yahoo",
  canFetch: (ctx) => Boolean(ctx.symbol),
  fetchPrice: async (ctx) => {
    try {
      const url =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(ctx.symbol) +
        "?interval=1d&range=5d";
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

      if (!res.ok) return fetchStooqFallback(ctx);

      const data = (await res.json()) as YahooChartResponse;
      const meta = data.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;

      if (price == null || !Number.isFinite(price)) return fetchStooqFallback(ctx);

      const currency = meta?.currency ?? ctx.currency;
      const priceInEur = await convertYahooPriceToEur(String(price), currency, ctx);

      return priceInEur
        ? { price: priceInEur, currency: "EUR" }
        : fetchStooqFallback(ctx);
    } catch {
      return fetchStooqFallback(ctx);
    }
  },
};

async function convertYahooPriceToEur(
  price: string,
  currency: string,
  ctx: Parameters<PriceProvider["fetchPrice"]>[0],
): Promise<string | null> {
  if (currency === "EUR") return price;

  const fx = await ecbProvider.fetchPrice({ ...ctx, symbol: currency });
  if (!fx || "failed" in fx) return null;

  const converted = Number(price) * Number(fx.price);
  if (!Number.isFinite(converted)) return null;

  return String(Math.round((converted + Number.EPSILON) * 100000000) / 100000000);
}

async function fetchStooqFallback(
  ctx: Parameters<PriceProvider["fetchPrice"]>[0],
): ReturnType<PriceProvider["fetchPrice"]> {
  const fallback = await stooqProvider.fetchPrice(ctx);

  // Propagate Stooq's failure reason (or null) verbatim; only stamp the source
  // on a successful quote so the cache records where the price actually came from.
  if (!fallback || "failed" in fallback) return fallback;

  return { ...fallback, source: stooqProvider.name };
}
