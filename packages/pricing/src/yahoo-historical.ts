/**
 * Yahoo historical price source (#922, ADR 0033).
 *
 * Fetches daily closes from Yahoo's chart API over an arbitrary millisecond range,
 * keyed by YYYY-MM-DD in EUR. Dates Yahoo cannot price are absent — never invented.
 */

import type { DecimalString } from "@worthline/domain";

import { fetchEcbDailyRatesEur } from "./ecb";
import { fetchHttpWithRetry, HttpTransientError } from "./fetch-with-retry";
import type { HistoricalPriceSeries } from "./historical-price-source";
import { decimalFromNumber } from "./yahoo";

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
/** Two-year chunks keep each chart request bounded on long backfills. */
const YAHOO_HISTORICAL_CHUNK_MS = 730 * 86_400_000;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;
/**
 * How far back a close's date may reach for an ECB rate. ECB only publishes
 * business days, so a weekend/holiday close carries the previous rate forward;
 * beyond a week the rate is considered missing and the date stays absent.
 */
const FX_CARRY_FORWARD_DAYS = 7;

export interface YahooHistoryResult {
  pricesByDate: ReadonlyMap<string, DecimalString>;
  fetchError?: string;
}

/**
 * Fetch a Yahoo symbol's daily EUR prices over [fromMs, toMs]. Never throws: a
 * miss or outage degrades to an empty map with `fetchError` when every chunk fails.
 */
export async function fetchYahooHistoryEur(
  providerSymbol: string,
  fromMs: number,
  toMs: number,
  nowIso?: string,
): Promise<YahooHistoryResult> {
  const symbol = providerSymbol.trim();
  if (!symbol) {
    return { pricesByDate: new Map() };
  }

  const cappedToMs = nowIso ? Math.min(toMs, Date.parse(nowIso)) : toMs;
  const rangeStart = Math.min(fromMs, cappedToMs);
  const rangeEnd = Math.max(fromMs, cappedToMs);
  if (
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd) ||
    rangeStart >= rangeEnd
  ) {
    return { pricesByDate: new Map() };
  }

  const rawPoints: Array<{ dateKey: string; price: number; currency: string }> = [];
  let fetchError: string | undefined;
  let anyChunkSucceeded = false;

  for (const chunk of chunkMillisecondRange(rangeStart, rangeEnd)) {
    const chunkResult = await fetchYahooHistoryChunk(symbol, chunk.fromMs, chunk.toMs);
    if (chunkResult.fetchError) {
      fetchError = chunkResult.fetchError;
      continue;
    }
    if (chunkResult.points.length === 0) continue;

    anyChunkSucceeded = true;
    const quoteCurrency = chunkResult.currency ?? "EUR";
    for (const point of chunkResult.points) {
      rawPoints.push({ ...point, currency: quoteCurrency });
    }
  }

  const pricesByDate = await convertPointsToEur(rawPoints, rangeStart, rangeEnd);

  if (fetchError && !anyChunkSucceeded) {
    return { pricesByDate, fetchError };
  }
  if (rawPoints.length > 0 && pricesByDate.size === 0) {
    // Yahoo delivered closes but no historical FX rate covered any of them.
    return { pricesByDate, fetchError: "ECB no devolvió tipos de cambio históricos" };
  }
  return { pricesByDate };
}

/**
 * Convert raw Yahoo closes to EUR using the ECB rate OF EACH CLOSE'S DATE —
 * never today's rate (a multi-year backfill converted at the current rate would
 * freeze systematically wrong values into snapshots). Rates are fetched once per
 * quote currency over the whole range; a date with no rate within the
 * carry-forward window stays absent, never invented.
 */
async function convertPointsToEur(
  rawPoints: ReadonlyArray<{ dateKey: string; price: number; currency: string }>,
  rangeStart: number,
  rangeEnd: number,
): Promise<Map<string, DecimalString>> {
  const pricesByDate = new Map<string, DecimalString>();
  const currencies = [...new Set(rawPoints.map((point) => point.currency))].filter(
    (currency) => currency !== "EUR",
  );

  const ratesByCurrency = new Map<string, ReadonlyMap<string, number>>();
  for (const currency of currencies) {
    ratesByCurrency.set(
      currency,
      await fetchEcbDailyRatesEur(
        currency,
        rangeStart - FX_CARRY_FORWARD_DAYS * MS_PER_DAY,
        rangeEnd,
      ),
    );
  }

  for (const point of rawPoints) {
    if (point.currency === "EUR") {
      pricesByDate.set(point.dateKey, decimalFromNumber(point.price));
      continue;
    }
    const rate = rateOnOrBefore(ratesByCurrency.get(point.currency), point.dateKey);
    if (rate === null) continue;
    const converted = point.price * rate;
    if (!Number.isFinite(converted) || converted <= 0) continue;
    pricesByDate.set(point.dateKey, decimalFromNumber(converted));
  }

  return pricesByDate;
}

/** The rate on `dateKey`, or carried forward from the previous business day. */
function rateOnOrBefore(
  rates: ReadonlyMap<string, number> | undefined,
  dateKey: string,
): number | null {
  if (!rates) return null;
  const dateMs = Date.parse(`${dateKey}T00:00:00.000Z`);
  if (!Number.isFinite(dateMs)) return null;

  for (let daysBack = 0; daysBack <= FX_CARRY_FORWARD_DAYS; daysBack += 1) {
    const key = new Date(dateMs - daysBack * MS_PER_DAY).toISOString().slice(0, 10);
    const rate = rates.get(key);
    if (rate !== undefined) return rate;
  }
  return null;
}

export const yahooHistoricalSource = {
  fetchSeriesEur: async (
    providerSymbol: string,
    fromMs: number,
    toMs: number,
  ): Promise<HistoricalPriceSeries> => {
    const { pricesByDate, fetchError } = await fetchYahooHistoryEur(
      providerSymbol,
      fromMs,
      toMs,
    );
    return {
      pricesByDate,
      source: "yahoo",
      ...(fetchError ? { fetchError } : {}),
    };
  },
};

function chunkMillisecondRange(
  fromMs: number,
  toMs: number,
): Array<{ fromMs: number; toMs: number }> {
  const chunks: Array<{ fromMs: number; toMs: number }> = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(cursor + YAHOO_HISTORICAL_CHUNK_MS, toMs);
    chunks.push({ fromMs: cursor, toMs: end });
    cursor = end;
  }
  return chunks;
}

interface YahooHistoryChunkResult {
  points: Array<{ dateKey: string; price: number }>;
  currency?: string;
  fetchError?: string;
}

async function fetchYahooHistoryChunk(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<YahooHistoryChunkResult> {
  const period1 = Math.floor(fromMs / MS_PER_SECOND);
  const period2 = Math.floor(toMs / MS_PER_SECOND);
  const url =
    `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}`;

  try {
    const res = await fetchHttpWithRetry(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        points: [],
        fetchError: `Yahoo respondió con un error (${res.status})`,
      };
    }

    const data = (await res.json()) as YahooChartResponse;
    const result = data.chart?.result?.[0];
    if (!result) {
      return { points: [] };
    }

    const points = extractYahooDailyCloses(result);
    const metaPoint = datedMetaPriceInRange(result.meta, fromMs, toMs);
    if (metaPoint && !points.some((point) => point.dateKey === metaPoint.dateKey)) {
      points.push(metaPoint);
    }

    return {
      points,
      ...(result.meta?.currency ? { currency: result.meta.currency } : {}),
    };
  } catch (err) {
    const message =
      err instanceof HttpTransientError
        ? `Yahoo respondió con un error (${err.status})`
        : err instanceof Error
          ? err.message
          : "Error de red al consultar Yahoo";
    return { points: [], fetchError: message };
  }
}

function extractYahooDailyCloses(
  result: YahooChartResult,
): Array<{ dateKey: string; price: number }> {
  const timestamps = result.timestamp ?? [];
  const close = result.indicators?.quote?.[0]?.close;
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose;
  const series = close ?? adjclose;
  if (!series) return [];

  const points: Array<{ dateKey: string; price: number }> = [];
  for (let index = 0; index < series.length; index += 1) {
    const price = series[index];
    if (price == null || !Number.isFinite(price) || price <= 0) continue;

    const timestamp = timestamps[index];
    if (timestamp == null || !Number.isFinite(timestamp)) continue;

    points.push({
      dateKey: new Date(timestamp * MS_PER_SECOND).toISOString().slice(0, 10),
      price,
    });
  }

  return points;
}

function datedMetaPriceInRange(
  meta: YahooChartResult["meta"] | undefined,
  fromMs: number,
  toMs: number,
): { dateKey: string; price: number } | null {
  const price = meta?.regularMarketPrice;
  const marketTime = meta?.regularMarketTime;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  if (marketTime == null || !Number.isFinite(marketTime) || marketTime <= 0) return null;

  const marketMs = marketTime * MS_PER_SECOND;
  if (marketMs < fromMs || marketMs > toMs) return null;

  return {
    dateKey: new Date(marketMs).toISOString().slice(0, 10),
    price,
  };
}
