import {
  BASE_CURRENCY,
  createFxRateSnapshot,
  FX_CARRY_FORWARD_DAYS,
  type FxRatePoint,
  type FxRateSnapshot,
} from "@worthline/domain";
import { fetchEcbDailyRatesEur } from "./ecb";

/**
 * The ECB adapter behind the domain's `MoneyConverter` port (#1065). It turns a set
 * of currencies + an `asOf` into a domain {@link FxRateSnapshot} of dated EUR-per-unit
 * observations, so the pure converter can price a non-EUR figure at that date (spot
 * for a present-day `asOf`). ECB is fetched live and NOT persisted — the same posture
 * as the historical backfill's on-demand FX; the deferred piece (#884) is a cached,
 * mass-backfill converter.
 *
 * Honest by construction: `fetchEcbDailyRatesEur` never throws (an outage degrades to
 * an empty map), so a currency ECB cannot price simply has no observations and the
 * snapshot returns `null` for it — the aggregation then EXCLUDES-and-marks that
 * holding rather than inventing a 1:1 rate.
 */

const MS_PER_DAY = 86_400_000;

/** The dated-rate fetcher, injectable so the adapter is unit-testable without network. */
export type EcbDailyRatesFetcher = (
  currency: string,
  fromMs: number,
  toMs: number,
) => Promise<ReadonlyMap<string, number>>;

export interface ResolveFxRateSnapshotOptions {
  /** Override the ECB fetcher (tests). Defaults to the live {@link fetchEcbDailyRatesEur}. */
  fetchDailyRates?: EcbDailyRatesFetcher;
}

/**
 * Build an {@link FxRateSnapshot} covering `currencies` at `asOf`. Each distinct
 * non-EUR currency (case-insensitive, EUR skipped since its pivot is always 1) is
 * fetched ONCE over the carry-forward window ending at `asOf`; a present-day `asOf`
 * therefore yields the latest observation as the spot rate. Never rejects.
 */
export async function resolveFxRateSnapshot(
  currencies: readonly string[],
  asOf: string,
  options: ResolveFxRateSnapshotOptions = {},
): Promise<FxRateSnapshot> {
  const fetchDailyRates = options.fetchDailyRates ?? fetchEcbDailyRatesEur;

  const wanted = new Map<string, string>();
  for (const raw of currencies) {
    const currency = raw.trim().toUpperCase();
    if (currency && currency !== BASE_CURRENCY) {
      wanted.set(currency, currency);
    }
  }

  const asOfMs = Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`);
  const toMs = Number.isFinite(asOfMs) ? asOfMs : Date.parse(`${asOf}`);
  const fromMs = toMs - FX_CARRY_FORWARD_DAYS * MS_PER_DAY;

  const pointsByCurrency: Record<string, FxRatePoint[]> = {};
  await Promise.all(
    [...wanted.values()].map(async (currency) => {
      const rates = await fetchDailyRates(currency, fromMs, toMs);
      pointsByCurrency[currency] = [...rates].map(([dateKey, eurPerUnit]) => ({
        dateKey,
        eurPerUnit,
      }));
    }),
  );

  return createFxRateSnapshot(pointsByCurrency);
}
