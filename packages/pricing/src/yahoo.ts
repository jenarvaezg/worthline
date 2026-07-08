import type { PriceProvider } from "./index";
import { fetchHttpWithRetry } from "./fetch-with-retry";
import { resolveProvider } from "./registry";

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
const YAHOO_STALE_MARKET_DATE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

// Yahoo only fetches from Yahoo. The Yahoo→Stooq fallback is policy, declared
// in `./registry` (`fallbackChains`) and applied by `fetchWithFallback`, so a
// Yahoo miss returns null here and the runner reaches for Stooq (issue #243).
// The EUR conversion (Yahoo→ECB FX) stays — it is a composition pipeline, not a
// fallback — but resolves ECB via the registry rather than a hardcoded import.
export const yahooProvider: PriceProvider = {
  name: "yahoo",
  fetchPrice: async (ctx) => {
    try {
      const url =
        YAHOO_CHART_URL + encodeURIComponent(ctx.symbol) + "?interval=1d&range=5d";
      const res = await fetchHttpWithRetry(url, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as YahooChartResponse;
      const result = data.chart?.result?.[0];
      const meta = result?.meta;
      const seriesPrice = latestSeriesPrice(result);
      if (isStaleYahooMarketDate(seriesPrice?.priceDate, ctx.nowIso)) return null;

      // Undated meta fallback cannot be judged for staleness — reject it so a
      // dead listing is not recorded as fresh (issue #730).
      const price = seriesPrice?.price ?? null;

      if (price == null || !Number.isFinite(price)) return null;

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
        : null;
    } catch {
      return null;
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

function isStaleYahooMarketDate(priceDate: string | undefined, nowIso: string): boolean {
  if (!priceDate) return false;

  const now = Date.parse(nowIso);
  const marketDate = Date.parse(`${priceDate}T00:00:00.000Z`);
  if (!Number.isFinite(now) || !Number.isFinite(marketDate)) return false;

  // Seven days tolerates weekends/holidays while rejecting dead listings.
  return now - marketDate > YAHOO_STALE_MARKET_DATE_DAYS * MS_PER_DAY;
}

async function convertYahooPriceToEur(
  price: string,
  currency: string,
  ctx: Parameters<PriceProvider["fetchPrice"]>[0],
): Promise<string | null> {
  if (currency === "EUR") return price;

  // FX conversion is a pipeline (Yahoo price × ECB rate must both succeed), not
  // a fallback — but ECB resolves through the registry so no cross-provider
  // import is buried in this body (issue #243).
  const fx = await resolveProvider("ecb").fetchPrice({ ...ctx, symbol: currency });
  if (!fx || "failed" in fx) return null;

  const converted = Number(price) * Number(fx.price);
  if (!Number.isFinite(converted)) return null;

  return String(Math.round((converted + Number.EPSILON) * 100000000) / 100000000);
}
