import type {
  DecimalString,
  ExposureCoverage,
  MoneyMinor,
  PortfolioCost,
} from "@worthline/domain";

import { type ExposureCoveragePart, formatExposureWeight } from "./exposure-view";

/**
 * Pure presentation logic for the portfolio-cost line of the /patrimonio
 * exposure section (#1717, interaction-patterns §7). The figures come already
 * derived from the domain `portfolioCost`; this module only decides which of the
 * three readings applies and how its numbers print, so it unit-tests in the node
 * env with no React.
 */

/** What the cost line says: an estimate, the gap, or that nothing charges a TER. */
export type PortfolioCostReading =
  | { kind: "estimated"; annualCost: MoneyMinor; terLabel: string; shareLabel: string }
  | { kind: "undeclared" }
  | { kind: "none" };

export function readPortfolioCost(cost: PortfolioCost): PortfolioCostReading {
  if (cost.weightedTer !== null) {
    return {
      annualCost: cost.annualCost,
      kind: "estimated",
      shareLabel: formatDeclaredShare(cost.declaredShare),
      terLabel: formatTerPercent(cost.weightedTer),
    };
  }
  // No mean exists. Funds without a TER are the gap the catalog has to close;
  // with none at all (cash, a house, shares) there is simply nothing to charge.
  return cost.coverage.unknown.amountMinor !== 0
    ? { kind: "undeclared" }
    : { kind: "none" };
}

/**
 * A TER fraction as an es-ES percent with two decimals (`"0.0018"` → `"0,18 %"`):
 * TERs live in hundredths of a percent, so the whole-percent exposure weight
 * would print every index fund as «0 %».
 */
export function formatTerPercent(ter: DecimalString): string {
  const percent = (Number(ter) * 100).toLocaleString("es-ES", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
  return `${percent} %`;
}

/** The declared share of gross as a whole percent, never a misleading «0 %». */
function formatDeclaredShare(share: DecimalString): string {
  const label = formatExposureWeight(share);
  return Number(share) > 0 && label === "0 %" ? "menos del 1 %" : label;
}

/**
 * The look-through's three-way coverage in TER words, zero parts kept so an
 * undeclared remainder is never hidden (#543's rule, applied to the TER).
 */
export function portfolioCostCoverageParts(
  coverage: ExposureCoverage,
): ExposureCoveragePart[] {
  return [
    { kind: "classified", label: "Con TER", value: coverage.classified },
    { kind: "notApplicable", label: "No aplica", value: coverage.notApplicable },
    { kind: "unknown", label: "Sin declarar", value: coverage.unknown },
  ];
}
