/**
 * Why a coin is worth 0 € (#1356, ADR 0017).
 *
 * `coinValue` answers *how much* a coin is worth by walking three rungs —
 * `max(metal, numismatic)` → purchase price → zero. This module answers the
 * question the `zero` basis leaves hanging: **which missing input put it there**,
 * so the data-quality signal can say what to go and record instead of repeating
 * "está a 0" once per coin.
 *
 * One coin reports ONE primary gap — the input that, supplied, would rescue it
 * cheapest — so a collection's gap counts add up to its unvalued count and a
 * breakdown line reads as a partition, not as overlapping tallies.
 */

import type { CoinPosition } from "./connected-source";
import { coinValue } from "./connected-source";

/**
 * The missing input that leaves a coin unvalued, ordered by which rung it blocks:
 * the melt floor first (`fineness`/`weight`/`spot`), then the numismatic estimate
 * (`grade`/`issue`/`estimate`).
 *
 * - `fineness` / `weight` — a precious-metal coin whose catalogue entry records no
 *   millesimal fineness / no weight, so the melt value cannot be computed.
 * - `spot` — every metal input is present but the metal quote never resolved: an
 *   outage, not something the user can record (the #1354 shape).
 * - `grade` — no condition rating on Numista, and the per-grade estimate cannot be
 *   requested without one.
 * - `issue` — Numista records no concrete issue for the line, so there is no issue
 *   to price.
 * - `estimate` — issue and grade are both there and Numista simply has no estimate
 *   for that combination; only a purchase price can rescue it.
 */
export type CoinValueGap =
  | "fineness"
  | "weight"
  | "spot"
  | "grade"
  | "issue"
  | "estimate";

/** The persisted coin fields the gap diagnosis reads — the valuation inputs, the
 *  two catalogue keys the numismatic estimate is requested with, and how many coins
 *  the line stands for (a breakdown counts COINS, not lines). */
export type CoinValueGapInput = Pick<
  CoinPosition,
  | "finenessMillis"
  | "grade"
  | "issueId"
  | "metal"
  | "metalValueMinor"
  | "numismaticValueMinor"
  | "purchasePriceMinor"
  | "quantity"
  | "weightGrams"
>;

/** Canonical order — the tie-break for equal counts, and the reading order of a
 *  breakdown line (strongest rescue first). */
const GAP_ORDER: readonly CoinValueGap[] = [
  "fineness",
  "weight",
  "spot",
  "grade",
  "issue",
  "estimate",
];

/** es-ES phrasing for each gap, written to slot after a count ("15 sin el peso…").
 *  The human copy lives here so the hero alert and the collection view name the
 *  same missing input the same way; the agent view keeps its own English wording. */
export const COIN_VALUE_GAP_LABEL: Record<CoinValueGap, string> = {
  estimate: "sin estimación de Numista para su grado",
  fineness: "sin la ley del metal en el catálogo",
  grade: "sin grado en Numista",
  issue: "sin emisión concreta en Numista",
  spot: "esperando la cotización del metal",
  weight: "sin el peso en el catálogo",
};

/**
 * The single missing input that leaves this coin at 0 €, or null when the coin is
 * valued (any rung). The melt branch is checked first because it is the FLOOR: a
 * weight and a fineness rescue a coin regardless of what Numista estimates, so a
 * coin missing both a fineness and a grade is reported against the fineness.
 *
 * A melt value of exactly 0 is not a value (`coinValue` only lets a positive
 * candidate win), but it is not a missing input either — such a coin falls through
 * to the numismatic branch rather than blaming the metal side.
 */
export function coinValueGap(coin: CoinValueGapInput): CoinValueGap | null {
  if (coinValue(coin).basis !== "zero") {
    return null;
  }

  if (coin.metal !== null) {
    if (coin.finenessMillis === null) {
      return "fineness";
    }
    if (coin.weightGrams === null) {
      return "weight";
    }
    if (coin.metalValueMinor === null) {
      return "spot";
    }
  }

  if (coin.grade.trim() === "") {
    return "grade";
  }
  if (coin.issueId === null) {
    return "issue";
  }
  return "estimate";
}

/**
 * The es-ES breakdown of what a set of coins is missing — "62 sin grado en
 * Numista, 15 sin la ley del metal en el catálogo" — most common gap first, ties
 * broken on the canonical order so the same collection always reads the same way.
 * Counts COINS, not lines: a Numista line can be `×3`, and that is what the
 * collection view counts ("178 monedas"), so the panel and the catalogue never
 * disagree about the same collection. The gaps therefore partition the collection's
 * unvalued coin count. Null when every coin is valued (nothing to report).
 */
export function summarizeCoinValueGaps(
  coins: readonly CoinValueGapInput[],
): string | null {
  const counts = new Map<CoinValueGap, number>();
  for (const coin of coins) {
    const gap = coinValueGap(coin);
    if (gap !== null) {
      counts.set(gap, (counts.get(gap) ?? 0) + coin.quantity);
    }
  }
  if (counts.size === 0) {
    return null;
  }

  return [...counts.entries()]
    .sort(
      ([leftGap, leftCount], [rightGap, rightCount]) =>
        rightCount - leftCount ||
        GAP_ORDER.indexOf(leftGap) - GAP_ORDER.indexOf(rightGap),
    )
    .map(([gap, count]) => `${count} ${COIN_VALUE_GAP_LABEL[gap]}`)
    .join(", ");
}
