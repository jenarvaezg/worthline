import type { HoldingReturnsView } from "@worthline/domain";

/**
 * Presentation formatting for investment returns (#551). The measure SELECTION
 * lives in the domain (`buildHoldingReturnsView`); this module only turns the
 * resulting view into es-ES strings — the signed percentages and the hover lines
 * every returns surface (board, hero, ficha) shares. A null measure renders as an
 * em dash, never a fabricated number (ADR 0040).
 */

/** A signed es-ES percentage from a fraction: 0.299 → "+29,9 %", −0.1 → "−10,0 %". */
export function formatRatioPct(ratio: number): string {
  const pct = ratio * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1).replace(".", ",")} %`;
}

/** Like {@link formatRatioPct}, but a null rate/ratio renders as an em dash. */
export function formatMeasurePct(rate: number | null): string {
  return rate === null ? "—" : formatRatioPct(rate);
}

function formatIsoDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * The hover lines explaining a holding's (or the portfolio's) returns. Market
 * instruments list the three measures with the total-vs-annualized distinction
 * and the honest caveats; appreciating assets show only the revalorización. Null
 * measures appear as em dashes, and the caveats are surfaced, never buried.
 */
export function returnsTooltipLines(view: HoldingReturnsView): string[] {
  const lines: string[] = [];

  if (view.kind === "appreciating") {
    lines.push(
      `Revalorización: ${formatMeasurePct(view.totalReturnRatio)} (valor actual − coste)`,
    );
  } else {
    lines.push(`Ganancia total: ${formatMeasurePct(view.totalReturnRatio)}`);
    if (view.annualized && view.cagr !== null) {
      lines.push(`Anualizada (CAGR): ${formatRatioPct(view.cagr)}`);
    }
    lines.push(`IRR anual: ${formatMeasurePct(view.irr?.rate ?? null)}`);
    const twrStart = view.twr?.startDate
      ? ` desde ${formatIsoDate(view.twr.startDate)}`
      : "";
    lines.push(`TWR${twrStart}: ${formatMeasurePct(view.twr?.rate ?? null)}`);
    if (view.twr?.annualized && view.twr.annualizedRate !== null) {
      lines.push(`TWR anualizado: ${formatRatioPct(view.twr.annualizedRate)}`);
    }
  }

  lines.push(...view.caveats);
  return lines;
}
