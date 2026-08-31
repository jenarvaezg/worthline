import { convertPriceToEur } from "./convert-to-eur";
import { fetchHttpWithRetry } from "./fetch-with-retry";
import type { PriceProvider } from "./index";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
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
// fallback — and lives in `./convert-to-eur`, which resolves ECB via the
// registry rather than a hardcoded import.
export const yahooProvider: PriceProvider = {
  name: "yahoo",
  fetchPrice: async (ctx) => {
    try {
      const url =
        YAHOO_CHART_URL + encodeURIComponent(ctx.symbol) + "?interval=1d&range=5d";
      const res = await fetchHttpWithRetry(url, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      });

      if (!res.ok) return null;

      const data = (await res.json()) as YahooChartResponse;
      const result = data.chart?.result?.[0];
      const meta = result?.meta;
      const quote = latestSeriesPrice(result) ?? datedMetaPrice(meta);
      if (isStaleYahooMarketDate(quote?.priceDate, ctx.nowIso)) return null;

      const price = quote?.price ?? null;
      if (price == null || !Number.isFinite(price)) return null;

      const currency = meta?.currency ?? ctx.currency;
      const priceInEur = await convertPriceToEur(decimalFromNumber(price), currency, ctx);

      return priceInEur
        ? {
            price: priceInEur,
            currency: "EUR",
            ...(quote?.priceDate ? { priceDate: quote.priceDate } : {}),
          }
        : null;
    } catch {
      return null;
    }
  },
};

export function decimalFromNumber(value: number): string {
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

/**
 * When Yahoo returns meta-only quotes (common for thin exchange listings such as
 * Stuttgart mutual funds), `regularMarketTime` supplies the as-of date so the
 * quote can be freshness-checked. Undated meta is still rejected (issue #730).
 */
function datedMetaPrice(
  meta: YahooChartResult["meta"] | undefined,
): { price: number; priceDate: string } | null {
  const price = meta?.regularMarketPrice;
  const marketTime = meta?.regularMarketTime;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  if (marketTime == null || !Number.isFinite(marketTime) || marketTime <= 0) return null;

  return {
    price,
    priceDate: new Date(marketTime * 1000).toISOString().slice(0, 10),
  };
}

function isStaleYahooMarketDate(priceDate: string | undefined, nowIso: string): boolean {
  if (!priceDate) return false;

  const now = Date.parse(nowIso);
  const marketDate = Date.parse(`${priceDate}T00:00:00.000Z`);
  if (!Number.isFinite(now) || !Number.isFinite(marketDate)) return false;

  // Seven days tolerates weekends/holidays while rejecting dead listings.
  return now - marketDate > YAHOO_STALE_MARKET_DATE_DAYS * MS_PER_DAY;
}
