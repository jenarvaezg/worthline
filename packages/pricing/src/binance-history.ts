/**
 * Binance monthly-history reconstruction (PRD #245, S5, ADR 0021).
 *
 * Derives the `BinanceHistoryCurve` the pure domain builder values. From Binance's
 * cheap daily SPOT snapshots (`getAccountSnapshots` — the API-cheap weeks-to-month
 * horizon) it takes each calendar month's LATEST snapshot as that month's end
 * balance per asset, then resolves each symbol → CoinGecko id and fetches each id's
 * daily EUR price series over the covered date range (deduped per id). An unmapped
 * symbol gets no price entries — the builder values it 0 — and a CoinGecko miss
 * leaves an empty series, never an error (the unpriceable-→-0 contract of ADR 0021).
 *
 * Every external read is injected, so the assembly is a pure unit of work testable
 * without the network; the web action (Pass B) wires the signed snapshot read and a
 * real CoinGecko range fetch.
 */

import type { BinanceHistoryCurve, DecimalString } from "@worthline/domain";

import { isBinanceFiatEur, resolveCoinGeckoId } from "./binance-symbols";
import { coingeckoBaseUrl, coingeckoHeaders } from "./coingecko";
import { fetchHttpWithRetry, HttpTransientError } from "./fetch-with-retry";

/** One normalized daily SPOT snapshot (mirrors `BinanceAccountSnapshot`). */
interface AccountSnapshot {
  dateKey: string;
  balances: { asset: string; balance: DecimalString }[];
}

/** The external reads the reconstruction needs, injected for testability. */
export interface ReconstructBinanceHistoryDeps {
  /** The account's daily SPOT snapshots (newest-or-oldest order is irrelevant). */
  accountSnapshots: () => Promise<AccountSnapshot[]>;
  /** A CoinGecko id's daily EUR price series over [fromDateKey, toDateKey],
   *  as dateKey → price. Empty on a miss/outage (never throws). */
  historicalPriceEur: (
    coingeckoId: string,
    fromDateKey: string,
    toDateKey: string,
  ) => Promise<ReadonlyMap<string, DecimalString>>;
}

export async function reconstructBinanceHistory(
  deps: ReconstructBinanceHistoryDeps,
): Promise<BinanceHistoryCurve> {
  const snapshots = await deps.accountSnapshots();

  // Month-end balance = the balances of the LATEST snapshot of each calendar month.
  // Group snapshots by monthKey, keep the max-dateKey snapshot per month, then fan
  // its per-asset balances out to `symbol → (monthKey → balance)`. An asset absent
  // from the latest snapshot is absent that month (it was sold/withdrawn by then).
  const latestSnapshotByMonth = new Map<string, AccountSnapshot>();
  for (const snapshot of snapshots) {
    const monthKey = snapshot.dateKey.slice(0, 7);
    const current = latestSnapshotByMonth.get(monthKey);
    if (current === undefined || snapshot.dateKey > current.dateKey) {
      latestSnapshotByMonth.set(monthKey, snapshot);
    }
  }

  const monthEndBalances = new Map<string, Map<string, DecimalString>>();
  for (const [monthKey, snapshot] of latestSnapshotByMonth) {
    for (const { asset, balance } of snapshot.balances) {
      let perMonth = monthEndBalances.get(asset);
      if (perMonth === undefined) {
        perMonth = new Map();
        monthEndBalances.set(asset, perMonth);
      }
      perMonth.set(monthKey, balance);
    }
  }

  // The covered date range bounds the price fetch (min/max snapshot dateKey).
  const dateKeys = snapshots.map((s) => s.dateKey).sort();
  const fromDateKey = dateKeys[0];
  const toDateKey = dateKeys[dateKeys.length - 1];

  // Resolve each symbol → CoinGecko id; fetch each distinct id's daily series once,
  // sharing the result across symbols that map to the same id (rate-cap hygiene).
  const dailyPriceBySymbol = new Map<string, ReadonlyMap<string, DecimalString>>();
  if (fromDateKey !== undefined && toDateKey !== undefined) {
    const seriesById = new Map<string, Promise<ReadonlyMap<string, DecimalString>>>();
    const fetchSeries = (id: string) => {
      let pending = seriesById.get(id);
      if (pending === undefined) {
        pending = deps.historicalPriceEur(id, fromDateKey, toDateKey);
        seriesById.set(id, pending);
      }
      return pending;
    };

    for (const symbol of monthEndBalances.keys()) {
      if (isBinanceFiatEur(symbol)) {
        dailyPriceBySymbol.set(symbol, flatEurPriceSeries(dateKeys));
        continue;
      }
      const id = resolveCoinGeckoId(symbol);
      if (id === null) continue; // unmapped → no price entries (valued 0 downstream)
      dailyPriceBySymbol.set(symbol, await fetchSeries(id));
    }
  }

  return { monthEndBalances, dailyPriceBySymbol };
}

/** The raw CoinGecko market-chart point: `[unixMs, eurPrice]`. */
type RawPricePoint = [number, number];

/** Result of a CoinGecko history-range fetch — never throws. */
export interface CoinGeckoHistoryResult {
  pricesByDate: ReadonlyMap<string, DecimalString>;
  /** Set when the fetch failed after retries (e.g. HTTP 429 on the public tier). */
  fetchError?: string;
}

function flatEurPriceSeries(
  dateKeys: readonly string[],
): ReadonlyMap<string, DecimalString> {
  return new Map(dateKeys.map((dateKey) => [dateKey, "1"]));
}

/**
 * Fetch a CoinGecko id's daily EUR price series over [fromMs, toMs] from
 * `/coins/{id}/market_chart/range`, parsed into a dateKey → price map. CoinGecko's
 * `from`/`to` are UNIX *seconds*; its `prices` are `[unixMs, eur]` points — for a
 * multi-week range it returns roughly one point per day, but several intraday
 * points are possible, so the LAST point of each UTC day wins (the closing-ish
 * quote). Never throws: a non-OK / thrown / price-less response → an empty map
 * with `fetchError` set so callers can surface the outage instead of silently
 * zeroing history (issue #730).
 *
 * `nowIso` (when given) clamps the upper bound so the request never reaches past
 * the present: a faithful, API-bounded history never values the future, even if a
 * snapshot's `toMs` somehow runs ahead of the wall clock.
 */
export async function fetchCoinGeckoHistoryEur(
  coingeckoId: string,
  fromMs: number,
  toMs: number,
  nowIso?: string,
): Promise<CoinGeckoHistoryResult> {
  const cappedToMs = nowIso ? Math.min(toMs, Date.parse(nowIso)) : toMs;
  const fromSec = Math.floor(fromMs / 1000);
  const toSec = Math.floor(cappedToMs / 1000);
  const url =
    `${coingeckoBaseUrl()}/coins/${encodeURIComponent(coingeckoId)}/market_chart/range` +
    `?vs_currency=eur&from=${fromSec}&to=${toSec}`;

  try {
    const res = await fetchHttpWithRetry(url, {
      headers: coingeckoHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        pricesByDate: new Map(),
        fetchError: `CoinGecko respondió con un error (${res.status})`,
      };
    }

    const data = (await res.json()) as { prices?: RawPricePoint[] };
    const byDate = new Map<string, DecimalString>();
    for (const [ms, eur] of data.prices ?? []) {
      // Iterating in CoinGecko's ascending-time order means the last write per day
      // is the day's latest point.
      byDate.set(new Date(ms).toISOString().slice(0, 10), String(eur));
    }
    return { pricesByDate: byDate };
  } catch (err) {
    const message =
      err instanceof HttpTransientError
        ? `CoinGecko respondió con un error (${err.status})`
        : err instanceof Error
          ? err.message
          : "Error de red al consultar CoinGecko";
    return { pricesByDate: new Map(), fetchError: message };
  }
}
