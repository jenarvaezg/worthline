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

import type { MetalKind } from "./metal";
import { metalValueMinor } from "./metal";
import type { NumistaPrices } from "./numista";
import { numismaticEstimateMinor } from "./numista";

/** The long TTL for refetching a coin's numismatic estimate (ADR 0017). */
export const NUMISMATIC_TTL_DAYS = 30;

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

export async function refreshCoinValuations(
  positions: RevaluePosition[],
  deps: RevalueDeps,
  options: RevalueOptions,
): Promise<RevaluedPosition[]> {
  const ttlMs = (options.numismaticTtlDays ?? NUMISMATIC_TTL_DAYS) * 86400000;
  const now = new Date(options.nowIso).getTime();

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
    // ── Metal: recompute from stored detail × fresh spot; outage keeps last-known.
    const spot = position.metal === null ? null : await resolveSpot(position.metal);
    const recomputed = metalValueMinor({
      metal: position.metal,
      finenessMillis: position.finenessMillis,
      weightGrams: position.weightGrams,
      quantity: position.quantity,
      spotPerOzEur: spot,
    });
    const metal = spot === null ? position.metalValueMinor : recomputed;

    // ── Numismatic: refetch only once the long TTL has lapsed (or never fetched).
    let numismaticValue = position.numismaticValueMinor;
    let numismaticFetchedAt = position.numismaticFetchedAt;

    const ageMs =
      position.numismaticFetchedAt === null
        ? Number.POSITIVE_INFINITY
        : now - new Date(position.numismaticFetchedAt).getTime();

    if (ageMs >= ttlMs && position.issueId !== null && position.grade) {
      const priced = await resolvePrices(position.typeId, position.issueId);
      if (priced !== null) {
        const perCoin = numismaticEstimateMinor(priced.prices, position.grade);
        numismaticValue = perCoin === null ? null : perCoin * position.quantity;
        numismaticFetchedAt = options.nowIso;
      }
      // priced === null → leave value + fetched-at untouched so it retries next pass.
    }

    results.push({
      id: position.id,
      metalValueMinor: metal,
      numismaticValueMinor: numismaticValue,
      numismaticFetchedAt,
    });
  }

  return results;
}
