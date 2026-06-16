/**
 * Coin valuation refresh (PRD #160 / #166, ADR 0017).
 *
 * The decoupled counterpart of the on-demand position sync ({@link
 * syncNumistaCollection}): the sync pulls *which* coins you hold and stamps their
 * indefinite detail; this re-derives *what they are worth* from fresh inputs,
 * riding worthline's existing stale-price pass. Metal spot is free (Stooq + ECB)
 * so the melt value is recomputed every pass from the stored detail; Numista's
 * per-grade estimate is rate-capped, so it is only refetched once its long TTL
 * lapses — keeping the daily pass well under 2,000 requests/month (ADR 0017).
 *
 * Pure + fully injected: no network, no clock. The web layer wires the real
 * readers (with the OAuth token) and a Stooq/ECB spot resolver.
 */

import { COIN_VALUE_TTL_DAYS, coinValuation, isNumismaticStale } from "./coin-valuation";
import type { MetalKind } from "./metal";
import type { NumistaPrices } from "./numista";

/** The long TTL for refetching a coin's numismatic estimate (ADR 0017). Sourced
 *  from the single coin-value staleness config so it never drifts behind a
 *  second independent literal (#240). */
export const NUMISMATIC_TTL_DAYS = COIN_VALUE_TTL_DAYS.numismaticEstimate;

/**
 * A stored coin position carrying the persisted detail needed to revalue it
 * without re-listing the collection: its catalogue/issue ids, grade, the
 * indefinite composition detail (metal/fineness/weight), the last-known candidate
 * values, and when the numismatic estimate was last fetched.
 */
export interface RevaluePosition {
  id: string;
  typeId: number;
  issueId: number | null;
  grade: string;
  quantity: number;
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  /** Last-known candidate values — kept when a refresh input is unavailable. */
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
  /** When the numismatic estimate was last fetched; null until first fetched. */
  numismaticFetchedAt: string | null;
}

/** A position's candidate values after a refresh pass. */
export interface RevaluedPosition {
  id: string;
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
  numismaticFetchedAt: string | null;
}

/** The external reads the refresh needs, injected for testability. */
export interface RevalueDeps {
  /** Per-grade estimates for an issue, or null when unavailable (Numista-capped). */
  prices: (typeId: number, issueId: number) => Promise<NumistaPrices | null>;
  /** Metal spot in EUR per troy ounce, or null on outage (free: Stooq + ECB). */
  spotPerOzEur: (metal: MetalKind) => Promise<number | null>;
}

export interface RevalueOptions {
  nowIso: string;
  /** Override the numismatic refetch TTL (defaults to {@link NUMISMATIC_TTL_DAYS}). */
  numismaticTtlDays?: number;
}

/** Whether a position's numismatic estimate is past its refetch TTL. Defers to
 *  the coin-value module's clock by default (#240); honours the test/override TTL
 *  when one is supplied. */
function numismaticPastTtl(
  fetchedAt: string | null,
  nowIso: string,
  overrideTtlDays: number | undefined,
): boolean {
  if (overrideTtlDays === undefined) {
    return isNumismaticStale(fetchedAt, nowIso);
  }
  if (fetchedAt === null) {
    return true;
  }
  const ageMs = new Date(nowIso).getTime() - new Date(fetchedAt).getTime();
  return ageMs >= overrideTtlDays * 86400000;
}

export async function refreshCoinValuations(
  positions: RevaluePosition[],
  deps: RevalueDeps,
  options: RevalueOptions,
): Promise<RevaluedPosition[]> {
  // Deduped per (metal) and per (type, issue) so a collection of N coins makes at
  // most one spot lookup per metal and one estimate lookup per issue (ADR 0017
  // request-cap discipline). Estimates memoize the in-flight promise so two
  // positions sharing an issue await the same single fetch.
  const spotByMetal = new Map<MetalKind, number | null>();
  const pricesByIssue = new Map<string, Promise<NumistaPrices | null>>();

  const resolveSpot = async (metal: MetalKind): Promise<number | null> => {
    if (!spotByMetal.has(metal)) {
      spotByMetal.set(metal, await deps.spotPerOzEur(metal));
    }
    return spotByMetal.get(metal) ?? null;
  };

  const resolvePrices = (
    typeId: number,
    issueId: number,
  ): Promise<NumistaPrices | null> => {
    const key = `${typeId}:${issueId}`;
    let pending = pricesByIssue.get(key);
    if (!pending) {
      pending = deps.prices(typeId, issueId);
      pricesByIssue.set(key, pending);
    }
    return pending;
  };

  const results: RevaluedPosition[] = [];
  for (const position of positions) {
    // ── Spot is fetched here (the I/O); the candidate math + decision live in the
    //    coin-value module. An outage keeps the last-known metal figure (#240).
    const spot = position.metal === null ? null : await resolveSpot(position.metal);

    // ── Numismatic: refetch only once the long TTL has lapsed (or never fetched);
    //    the staleness clock is the module's. A successful fetch advances the
    //    fetched-at stamp and supplies fresh prices to the module; otherwise we
    //    keep the prior stamp and pass null prices so it keeps the last-known.
    let prices: NumistaPrices | null = null;
    let numismaticFetchedAt = position.numismaticFetchedAt;

    if (
      numismaticPastTtl(
        position.numismaticFetchedAt,
        options.nowIso,
        options.numismaticTtlDays,
      ) &&
      position.issueId !== null &&
      position.grade
    ) {
      const priced = await resolvePrices(position.typeId, position.issueId);
      if (priced !== null) {
        prices = priced;
        numismaticFetchedAt = options.nowIso;
      }
      // priced === null → leave value + fetched-at untouched so it retries next pass.
    }

    const valuation = coinValuation({
      metal: position.metal,
      finenessMillis: position.finenessMillis,
      weightGrams: position.weightGrams,
      quantity: position.quantity,
      grade: position.grade,
      spotPerOzEur: spot,
      prices: prices?.prices ?? null,
      numismaticFetchedAt,
      // The fallback rungs do not apply to the candidate refresh; the rollup owns
      // the purchase/zero choice when both candidates are unresolved.
      purchasePriceMinor: null,
      lastMetalValueMinor: position.metalValueMinor,
      lastNumismaticValueMinor: position.numismaticValueMinor,
      nowIso: options.nowIso,
    });

    results.push({
      id: position.id,
      metalValueMinor: valuation.metal.minor,
      numismaticValueMinor: valuation.numismatic.minor,
      numismaticFetchedAt,
    });
  }

  return results;
}
