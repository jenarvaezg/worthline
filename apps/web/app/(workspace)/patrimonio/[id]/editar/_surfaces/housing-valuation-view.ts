/**
 * The rules a property's ficha reads in two places — its state header and its
 * «Valoración» tab (#1847) — written once, so the two can never say different
 * things about the same flat.
 *
 * Pure (interaction-patterns §7): the family reads the rows and renders; what the
 * value is today, which appraisal is the last, and when a result against the cost
 * exists at all are decided — and tested — here.
 */

import type { ValuationAnchorRecord } from "@worthline/db";
import type { MoneyMinor, ValuationCadence } from "@worthline/domain";
import { valueHousingAtDate } from "@worthline/domain";

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

/** Render a stored decimal rate ("0.03") back as the percent the user typed ("3"). */
export function rateToPercentInput(rate: string | null): string {
  if (rate === null) {
    return "";
  }

  const pct = Number(rate) * 100;

  // Trim float noise (0.07 * 100 = 7.000000000000001) without dropping real decimals.
  return String(Math.round(pct * 1_000_000) / 1_000_000);
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

/**
 * The property's value today, by the calculation the board's row runs
 * (`readCurveValuedHoldingsAtDate` → `valueLiveHoldingsAtDate`): its anchors, its
 * rate and its cadence, with the stored value as the curve's fallback basis and
 * today as both the "today" and the date valued.
 */
export function housingValueToday(input: {
  anchors: readonly Pick<
    ValuationAnchorRecord,
    "adjustsPriorCurve" | "valuationDate" | "valueMinor"
  >[];
  appreciationRate: string | null;
  cadence: ValuationCadence | null;
  currentValueMinor: number;
  today: string;
}): number {
  return valueHousingAtDate({
    anchors: input.anchors.map((anchor) => ({
      adjustsPriorCurve: anchor.adjustsPriorCurve,
      valuationDate: anchor.valuationDate,
      valueMinor: anchor.valueMinor,
    })),
    annualAppreciationRate: input.appreciationRate,
    currentValueMinor: input.currentValueMinor,
    ...(input.cadence != null ? { cadence: input.cadence } : {}),
    targetDate: input.today,
    today: input.today,
  });
}
