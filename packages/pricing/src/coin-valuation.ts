/**
 * Coin-value module (#240, ADR 0017).
 *
 * The SINGLE deep module that answers, for one coin position: **what is it worth,
 * and how fresh is each input that produced that worth?** It owns the whole rule
 * in one place — the two candidate computations (metal = composition × weight ×
 * spot; numismatic = the per-grade estimate), the GREATER-of decision (delegated
 * to the domain's `coinValue`, never duplicated), the purchase-price/zero fallback,
 * and BOTH refresh cadences. Previously these were spread across four pricing
 * modules with two disconnected staleness clocks; this consolidates them.
 *
 * Pure: the I/O (the metal-spot fetch, the Numista per-grade fetch) stays in the
 * sync/revalue orchestration and is passed in here. The *choice of when something
 * is stale* and the *assembly + decision* live here.
 */

import type { CoinValuation } from "@worthline/domain";
import { coinValue, PRICE_TTL_DAYS } from "@worthline/domain";

import type { MetalKind } from "./metal";
import { metalValueMinor } from "./metal";
import type { NumistaPriceEntry } from "./numista";
import { numismaticEstimateMinor } from "./numista";

const MS_PER_DAY = 86400000;

/**
 * The one place "how stale is this coin's value?" is answerable. The metal spot
 * rides the SAME shared per-source cadence as the rest of the dashboard's daily
 * quotes (`PRICE_TTL_DAYS.numista`, see packages/domain/src/prices.ts); the
 * numismatic estimate rides its own long cadence so the daily pass stays well
 * under Numista's request cap (ADR 0017). Both cadences live here together so
 * neither drifts behind an independent literal.
 */
export const COIN_VALUE_TTL_DAYS = {
  /** Metal-spot freshness — the shared daily source cadence (no behaviour change). */
  metalSpot: PRICE_TTL_DAYS.numista,
  /** Numismatic-estimate freshness — the long TTL that rate-caps Numista refetches. */
  numismaticEstimate: 30,
} as const;

/** Everything the coin-value module needs to value one position and judge its
 *  freshness. The fetched spot/prices are injected (the fetch stays in the
 *  orchestration); the last-known candidate values let a stale input keep the
 *  prior figure rather than zero it. */
export interface CoinValuationInput {
  /** The position's precious metal, or null for a base-metal coin (no melt value). */
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  quantity: number;
  grade: string;
  /** The freshly-fetched metal spot (EUR/oz), or null on outage. */
  spotPerOzEur: number | null;
  /** The freshly-fetched per-grade estimates, or null when not fetched this pass. */
  prices: readonly NumistaPriceEntry[] | null;
  /** When the numismatic estimate was last fetched (ISO); null until first fetched. */
  numismaticFetchedAt: string | null;
  /** What was paid for the position (minor), the fallback rung; null when unknown. */
  purchasePriceMinor: number | null;
  /** Last-known candidates, kept when the matching input is stale/unavailable. */
  lastMetalValueMinor: number | null;
  lastNumismaticValueMinor: number | null;
  /** ISO "now" for both staleness clocks. */
  nowIso: string;
}

/** A single candidate value plus whether the input that produced it is fresh. */
export interface CandidateValuation {
  /** The candidate value in minor units, or null when unresolved. */
  minor: number | null;
  /** Whether the candidate's underlying input is fresh per its cadence. */
  fresh: boolean;
}

/** The numismatic candidate also carries when it was last fetched (its clock). */
export interface NumismaticValuation extends CandidateValuation {
  fetchedAt: string | null;
}

/** A coin's value with the basis that produced it, plus each candidate's freshness. */
export interface CoinValueResult {
  /** The chosen value (greater of metal/numismatic → purchase → 0), via domain. */
  value: CoinValuation;
  metal: CandidateValuation;
  numismatic: NumismaticValuation;
}

/**
 * Whether a coin's numismatic estimate is stale per the 30-day cadence: past the
 * TTL, or never fetched. The shared metal-spot cadence is governed elsewhere by
 * the dashboard's stale-price pass (`PRICE_TTL_DAYS.numista`); this is the one
 * clock the coin-value module owns directly.
 */
export function isNumismaticStale(fetchedAt: string | null, nowIso: string): boolean {
  if (fetchedAt === null) {
    return true;
  }
  const ageMs = new Date(nowIso).getTime() - new Date(fetchedAt).getTime();
  return ageMs >= COIN_VALUE_TTL_DAYS.numismaticEstimate * MS_PER_DAY;
}

/**
 * Value one coin position and judge the freshness of each candidate (#240, ADR
 * 0017). Recomputes the metal candidate from the fresh spot (an outage keeps the
 * last-known figure, never zeroes it); reads the numismatic candidate from the
 * fetched per-grade prices (when none were fetched this pass, keeps the
 * last-known); then delegates the GREATER-of / purchase / zero choice to the
 * domain's `coinValue`, so the recorded decision is byte-identical to the rollup.
 */
export function coinValuation(input: CoinValuationInput): CoinValueResult {
  // ── Metal: recompute from the fresh spot; an outage keeps the last-known value.
  const metalFresh = input.spotPerOzEur !== null;
  const recomputed = metalValueMinor({
    metal: input.metal,
    finenessMillis: input.finenessMillis,
    weightGrams: input.weightGrams,
    quantity: input.quantity,
    spotPerOzEur: input.spotPerOzEur,
  });
  const metalMinor = metalFresh ? recomputed : input.lastMetalValueMinor;

  // ── Numismatic: read the fetched per-grade estimate; no fetch keeps last-known.
  const numismaticFresh = !isNumismaticStale(input.numismaticFetchedAt, input.nowIso);
  let numismaticMinor: number | null;
  if (input.prices === null) {
    numismaticMinor = input.lastNumismaticValueMinor;
  } else {
    const perCoin = numismaticEstimateMinor(input.prices, input.grade);
    numismaticMinor = perCoin === null ? null : perCoin * input.quantity;
  }

  // ── Decision: delegate the rule to the domain (single source of truth).
  return {
    value: coinValue({
      metalValueMinor: metalMinor,
      numismaticValueMinor: numismaticMinor,
      purchasePriceMinor: input.purchasePriceMinor,
    }),
    metal: { minor: metalMinor, fresh: metalFresh },
    numismatic: {
      minor: numismaticMinor,
      fresh: numismaticFresh,
      fetchedAt: input.numismaticFetchedAt,
    },
  };
}
