/**
 * Pure hover logic for the composition chart (#143 follow-up): the cursor→period
 * snapping, the consolidated tooltip rows, and the short date label. Kept in a
 * plain (non-client) module so it stays unit-testable in the node test
 * environment while the client component holds only the thin mouse wiring.
 */

import type { CompositionAssetBandId, CompositionPeriodGeometry } from "@worthline/domain";

export const COMPOSITION_BAND_LABELS: Record<CompositionAssetBandId, string> = {
  cash: "Caja",
  illiquid: "Ilíquido",
  housing: "Vivienda",
  market: "Mercado",
  "term-locked": "A plazo",
};

/** One line of the consolidated period tooltip. */
export interface CompositionTooltipRow {
  label: string;
  valueMinor: number;
  kind: "asset" | "debt" | "net";
}

/**
 * The index of the period whose x is closest to `xInViewBox` (viewBox units),
 * clamping to the ends outside the data range. Drives the cursor→period snap so
 * hovering anywhere in the chart resolves to one moment.
 */
export function nearestPeriodIndex(periodXs: readonly number[], xInViewBox: number): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < periodXs.length; i += 1) {
    const distance = Math.abs(periodXs[i]! - xInViewBox);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * The consolidated tooltip rows for one period: the five asset bands in stacking
 * order, the aggregated debt (only when the period carries any), and the
 * net-worth total — "all the values for that moment".
 */
export function compositionTooltipRows(
  period: CompositionPeriodGeometry,
): CompositionTooltipRow[] {
  const rows: CompositionTooltipRow[] = period.assetBands.map((anchor) => ({
    kind: "asset",
    label: COMPOSITION_BAND_LABELS[anchor.band],
    valueMinor: anchor.valueMinor,
  }));

  if (period.debt) {
    rows.push({ kind: "debt", label: "Deudas", valueMinor: period.debt.valueMinor });
  }

  rows.push({ kind: "net", label: "Patrimonio neto", valueMinor: period.netWorth.valueMinor });

  return rows;
}

const SHORT_MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

/** "2026-05-31" → "31 may 2026". */
export function formatTooltipDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-");
  return `${Number(day)} ${SHORT_MONTHS[Number(month) - 1] ?? ""} ${year ?? ""}`;
}
