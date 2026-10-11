import { formatFinePercent } from "@web/_components/fine-percent";
import type {
  DecimalString,
  MoneyMinor,
  PortfolioCost,
  PortfolioCostCoverage,
} from "@worthline/domain";

import {
  type CoverageLabels,
  coverageParts,
  type ExposureCoveragePart,
  formatExposureWeight,
} from "./exposure-view";

/**
 * Pure presentation logic for the portfolio-cost line of the /patrimonio
 * exposure section (#1717, ADR 0109, interaction-patterns §7). The figures come
 * already derived from the domain `portfolioCost`; this module only decides which
 * of the three readings applies and how its numbers print, so it unit-tests in the
 * node env with no React.
 */

/**
 * What the cost line says, by the coverage trio: a declared TER prices the year,
 * funds without one are the gap, and a portfolio with nothing to charge says so.
 */
export type PortfolioCostReading =
  | { kind: "declared"; annualCost: MoneyMinor; terLabel: string; shareLabel: string }
  | { kind: "undeclared" }
  | { kind: "notApplicable" };

export function readPortfolioCost(cost: PortfolioCost): PortfolioCostReading {
  if (cost.weightedTer !== null) {
    return {
      annualCost: cost.annualCost,
      kind: "declared",
      shareLabel: formatDeclaredShare(cost.declaredShare),
      // TERs live in hundredths of a percent: a whole-percent weight would print
      // every index fund as «0 %».
      terLabel: formatFinePercent(Number(cost.weightedTer)),
    };
  }
  // No mean exists. Funds without a TER are the gap the catalog has to close;
  // with none at all (cash, a house, shares) there is simply nothing to charge.
  return cost.coverage.undeclared.amountMinor !== 0
    ? { kind: "undeclared" }
    : { kind: "notApplicable" };
}

/** The declared share of gross as a whole percent, never a misleading «0 %». */
function formatDeclaredShare(share: DecimalString): string {
  const label = formatExposureWeight(share);
  return Number(share) > 0 && label === "0 %" ? "menos del 1 %" : label;
}

const TER_COVERAGE_LABELS: CoverageLabels = {
  classified: "Con TER",
  notApplicable: "No aplica",
  unknown: "Sin declarar",
};

/**
 * The cost's coverage through the look-through's one readout rule, in TER words:
 * declared → «Con TER», undeclared → «Sin declarar», which keeps the gap's warning
 * hue (#543's rule, applied to the TER).
 */
export function portfolioCostCoverageParts(
  coverage: PortfolioCostCoverage,
): ExposureCoveragePart[] {
  return coverageParts(
    {
      classified: coverage.declared,
      notApplicable: coverage.notApplicable,
      unknown: coverage.undeclared,
    },
    TER_COVERAGE_LABELS,
  );
}
