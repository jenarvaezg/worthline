/**
 * The ECB rates a MyInvestor read keeps (#1899, ADR 0072): the day of each of its
 * orders in another currency, asked WHEN MyInvestor is read — «Leer mis productos»,
 * the sync and «Resincronizar todo» — and kept with the read (`fxRates`). The fold
 * that previews and the one that writes then convert with the very same rates, and
 * the Conexiones page reads only the store.
 *
 * Only what the read lacks is asked: the rates it already kept (`known`) stay, so a
 * daily pass with no new order abroad asks nothing. One request per currency, with a
 * short deadline and no retries: the ECB must never hold up a read of MyInvestor.
 * It never rejects; an outage leaves the missing days missing, and the fold makes
 * those orders wait for a later read instead of inventing a rate.
 */
import type { FxRatePoint } from "@worthline/domain";
import {
  BASE_CURRENCY,
  createFxRateSnapshot,
  isCaptureCurrency,
} from "@worthline/domain";
import {
  type EcbDailyRatesFetcher,
  fetchEcbDailyRatesEur,
  type ResolveFxRateSnapshotOptions,
  resolveFxRateSnapshotForDates,
} from "@worthline/pricing";
import type { MyInvestorDiscovery } from "./myinvestor-discovery";
import { myInvestorRatesOf } from "./myinvestor-operations-fold";

/** Per request: a slow ECB loses fast, and is not asked twice. */
const ECB_TIMEOUT_MS = 4_000;

const quickEcb: EcbDailyRatesFetcher = (currency, fromMs, toMs) =>
  fetchEcbDailyRatesEur(currency, fromMs, toMs, {
    maxAttempts: 1,
    timeoutMs: ECB_TIMEOUT_MS,
  });

type Rates = Readonly<Record<string, readonly FxRatePoint[]>>;

/**
 * The read with the rate of each day it has an order in another currency, from
 * `known` (what an earlier read kept) or else from the ECB; a day neither has is left
 * out. A read in euros only comes back as it was, and asks nothing.
 */
export async function withMyInvestorRates(
  discovery: MyInvestorDiscovery,
  options: ResolveFxRateSnapshotOptions & { known?: Rates | undefined } = {},
): Promise<MyInvestorDiscovery> {
  const days = new Map<string, Set<string>>();
  for (const { payload } of discovery.operations) {
    if (payload.currency === BASE_CURRENCY || !isCaptureCurrency(payload.currency)) {
      continue;
    }
    const set = days.get(payload.currency) ?? new Set<string>();
    set.add(payload.executedAt.slice(0, 10));
    days.set(payload.currency, set);
  }
  const { fxRates: _stale, ...rest } = discovery;
  if (days.size === 0) return rest;

  // By the exact day: a kept point is the rate of an order's day, not an ECB one.
  const known = myInvestorRatesOf({
    fxRates: mergeRates(discovery.fxRates ?? {}, options.known ?? {}),
  });
  const lacking = [...days].flatMap(([currency, set]) =>
    [...set]
      .filter((day) => known.eurPerUnit(currency, day) === null)
      .map((day) => ({ currency, day })),
  );
  const fetched =
    lacking.length === 0
      ? createFxRateSnapshot({})
      : await resolveFxRateSnapshotForDates(
          lacking.map((entry) => entry.currency),
          lacking.map((entry) => entry.day),
          { fetchDailyRates: options.fetchDailyRates ?? quickEcb },
        );

  const fxRates: Record<string, FxRatePoint[]> = {};
  for (const [currency, set] of days) {
    for (const day of [...set].sort()) {
      const eurPerUnit =
        known.eurPerUnit(currency, day) ?? fetched.eurPerUnit(currency, day);
      if (eurPerUnit === null) continue;
      fxRates[currency] = [...(fxRates[currency] ?? []), { dateKey: day, eurPerUnit }];
    }
  }
  return Object.keys(fxRates).length === 0 ? rest : { ...rest, fxRates };
}

/** Two sets of kept rates as one; on the same day, `later`'s wins. */
function mergeRates(earlier: Rates, later: Rates): Rates {
  const merged: Record<string, FxRatePoint[]> = {};
  for (const source of [earlier, later]) {
    for (const [currency, points] of Object.entries(source)) {
      const byDay = new Map((merged[currency] ?? []).map((p) => [p.dateKey, p]));
      for (const point of points) byDay.set(point.dateKey, point);
      merged[currency] = [...byDay.values()];
    }
  }
  return merged;
}
