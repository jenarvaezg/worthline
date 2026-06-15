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
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
        adjclose?: Array<{
          adjclose?: Array<number | null>;
        }>;
      };
    }>;
  };
}

type YahooChartResult = NonNullable<
  NonNullable<YahooChartResponse["chart"]>["result"]
>[number];

const YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/";

export const yahooProvider: PriceProvider = {
  name: "yahoo",
  canFetch: (ctx) => Boolean(ctx.symbol),
  fetchPrice: async (ctx) => {
    try {
      const url =
        YAHOO_CHART_URL + encodeURIComponent(ctx.symbol) + "?interval=1d&range=5d";
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) return fetchStooqFallback(ctx);

      const data = (await res.json()) as YahooChartResponse;
      const result = data.chart?.result?.[0];
      const meta = result?.meta;
      const seriesPrice = latestSeriesPrice(result);
      const price = seriesPrice?.price ?? meta?.regularMarketPrice;

      if (price == null || !Number.isFinite(price)) return fetchStooqFallback(ctx);

      const currency = meta?.currency ?? ctx.currency;
      const priceInEur = await convertYahooPriceToEur(
        decimalFromNumber(price),
        currency,
        ctx,
      );

      return priceInEur
        ? {
            price: priceInEur,
            currency: "EUR",
            ...(seriesPrice?.priceDate ? { priceDate: seriesPrice.priceDate } : {}),
          }
        : fetchStooqFallback(ctx);
    } catch {
      return fetchStooqFallback(ctx);
    }
  },
};

function decimalFromNumber(value: number): string {
  return String(Math.round((value + Number.EPSILON) * 100000000) / 100000000);
}

function latestSeriesPrice(
  result: YahooChartResult | undefined,
): { price: number; priceDate?: string } | null {
  const timestamps = result?.timestamp ?? [];
  const close = result?.indicators?.quote?.[0]?.close;
  const adjclose = result?.indicators?.adjclose?.[0]?.adjclose;
  const series = close ?? adjclose;

  if (!series) return null;

  for (let index = series.length - 1; index >= 0; index -= 1) {
    const price = series[index];
    if (price == null || !Number.isFinite(price) || price <= 0) continue;

    const timestamp = timestamps[index];
    return {
      price,
      ...(timestamp
        ? { priceDate: new Date(timestamp * 1000).toISOString().slice(0, 10) }
        : {}),
    };
  }

  return null;
}

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
