import type { BenchmarkPricePoint } from "./ine-cpi";
import { decimalFromNumber } from "./yahoo";

const YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/";
const MONTHLY_RANGE = "10y";

interface YahooMonthlyChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }> | null;
  };
}

/**
 * Fetch monthly benchmark prices from Yahoo (ADR 0060, #625; Stooq retired in
 * #1354). Uses the chart endpoint's monthly interval so the control-plane cache
 * stores one row per month — the same shape as INE CPI. Dates are normalized to
 * the first of the month for alignment with the benchmark-comparison month-key
 * matcher, and the LAST close of a month wins when several land in one.
 *
 * Replaces `fetchStooqMonthlyBenchmark`, which fed `benchmark_prices` a row
 * dated `"(async(-01"` for months: Stooq answered with a JavaScript challenge
 * page and the CSV parser split it by commas. Two properties make that
 * impossible here: the body must parse as JSON (an HTML page never does), and
 * every point must clear the shape check below — a real epoch timestamp and a
 * finite, strictly positive close. Anything else is not a row.
 *
 * THROWS on anything that means "this series cannot be fetched" — an HTTP error,
 * a body that is not JSON (an anti-bot page), or a payload with no chart result
 * (an unknown symbol) — so the cron's benchmark phase records the series as
 * failed and the miss is visible. Returning `[]` there would leave a mistyped
 * catalog symbol permanently empty in silence, which is the exact failure class
 * this issue exists to kill. `[]` is reserved for a real series that simply
 * carries no usable close.
 */
export async function fetchYahooMonthlyBenchmark(
  symbol: string,
  options: {
    fetchImpl?: typeof fetch;
  } = {},
): Promise<BenchmarkPricePoint[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?interval=1mo&range=${MONTHLY_RANGE}`;
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Yahoo responded with ${res.status}`);
  }

  const result = parseChartResult(await res.text());
  const timestamps = result.timestamp ?? [];
  const closes =
    result.indicators?.quote?.[0]?.close ?? result.indicators?.adjclose?.[0]?.adjclose;
  if (!closes) {
    return [];
  }

  // Later points overwrite earlier ones for the same month key: with
  // `interval=1mo` there is one per month, but a partial current month can
  // repeat and the freshest close is the one worth keeping.
  const byMonthStart = new Map<string, string>();
  for (let index = 0; index < timestamps.length; index += 1) {
    const dateKey = monthStartFromTimestamp(timestamps[index]);
    const close = closes[index];
    if (dateKey === null || !isUsableClose(close)) continue;
    byMonthStart.set(dateKey, decimalFromNumber(close));
  }

  return [...byMonthStart]
    .map(([dateKey, value]) => ({ dateKey, value }))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}

/**
 * The chart payload. Throws when the body is not JSON (an error/challenge page
 * dressed as HTTP 200) or carries no result (an unknown symbol) — both are
 * fetch failures the caller must report, not empty series.
 */
function parseChartResult(
  body: string,
): NonNullable<NonNullable<YahooMonthlyChartResponse["chart"]>["result"]>[number] {
  let data: YahooMonthlyChartResponse;
  try {
    data = JSON.parse(body) as YahooMonthlyChartResponse;
  } catch {
    throw new Error("Yahoo returned a non-JSON body (not a chart payload)");
  }

  const result = data.chart?.result?.[0];
  if (!result) {
    throw new Error("Yahoo returned no chart result (unknown symbol?)");
  }
  return result;
}

/** `YYYY-MM-01` for an epoch-seconds timestamp, or null when it is not one. */
function monthStartFromTimestamp(timestamp: number | undefined): string | null {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  const iso = new Date(timestamp * 1000).toISOString();
  return `${iso.slice(0, 7)}-01`;
}

/** A close is usable only when finite and strictly positive (0 is "no price"). */
function isUsableClose(close: number | null | undefined): close is number {
  return close != null && Number.isFinite(close) && close > 0;
}
