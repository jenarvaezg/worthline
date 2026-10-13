/**
 * The rules a property's ficha reads in two places — its state header and its
 * «Valoración» tab (#1847) — written once, so the two can never say different
 * things about the same flat.
 *
 * Pure (interaction-patterns §7): the family reads the rows and renders; which
 * appraisal is the last, and when a result against the cost exists at all are
 * decided — and tested — here. What the value is today is the board's own reading:
 * `housingCurveInput` (`@worthline/db`), walked by `valueHousingAtDate`.
 */

import type { ValuationAnchorRecord } from "@worthline/db";
import type { MoneyMinor } from "@worthline/domain";

type AnchorKind = Pick<ValuationAnchorRecord, "adjustsPriorCurve" | "kind">;

/** The Tipo column's words: what the anchor is, by name (#1437). */
export function anchorKindLabel(
  anchor: AnchorKind,
): "Adquisición" | "Tasación" | "Mejora" {
  if (anchor.kind === "acquisition") return "Adquisición";
  return anchor.adjustsPriorCurve ? "Tasación" : "Mejora";
}

/**
 * «Última tasación»: the most recent anchor that is not after today — an
 * acquisition, an appraisal or an improvement alike, as the table lists them.
 */
export function latestAnchor<A extends Pick<ValuationAnchorRecord, "valuationDate">>(
  anchors: readonly A[],
  today: string,
): A | null {
  let latest: A | null = null;
  for (const anchor of anchors) {
    if (anchor.valuationDate > today) continue;
    if (latest === null || anchor.valuationDate > latest.valuationDate) latest = anchor;
  }
  return latest;
}

/**
 * «Resultado frente al coste» (#1441): the value it is handed minus what was
 * disbursed. It needs BOTH halves. Without a cost there is no result to show and a
 * 0 % would be an invention — the properties on the book start without one on
 * purpose, and the line stays away until someone reads the escritura. Without a
 * value it would read as a total loss of everything disbursed, which is a valuation
 * that has not happened yet, not a result.
 *
 * The value is the board row's — the curve's today (#1847) — in the header and in
 * the tab alike; the raw column drifts from it as soon as there is a rate.
 */
export function resultAgainstCost(
  acquisitionCostMinor: number | null,
  value: MoneyMinor,
): MoneyMinor | null {
  if (acquisitionCostMinor === null || value.amountMinor <= 0) return null;
  return {
    amountMinor: value.amountMinor - acquisitionCostMinor,
    currency: value.currency,
  };
}
