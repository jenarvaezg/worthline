import Big from "big.js";

import type { DecimalString } from "./decimal";
import { divideUnits, toMinorInt } from "./decimal";
import { FUND_WRAPPER_INSTRUMENTS } from "./exposure-identity";
import {
  type ExposureLookthroughInput,
  resolveExposureProfile,
} from "./exposure-lookthrough";
import type { MoneyMinor } from "./money";

/**
 * Lo que la cartera cuesta (#1717, ADR 0109): the value-weighted mean TER and its
 * reading in money per year (Σ value × TER), a lens derived from the exposure
 * catalog like geography or currency — never a figure the math reads.
 *
 * THE invariant: no return reads a TER. A fund's net asset value is already net
 * of its ongoing charges, so subtracting the TER from a rentabilidad would charge
 * it twice. `tests/portfolio-cost-ter.guardian.test.ts` holds the closed lists of
 * the files allowed to reach this lens and to read a `ter` at all.
 */

/**
 * The look-through's own input, minus what only the look-through reads: the same
 * rows, gross and catalog, so the coverage this lens declares is over the same
 * gross the exposure section shows. Each holding's `valueMinor` is already in the
 * gross currency — the FX layer (#1065) converted it upstream; the lens never sees
 * a native foreign amount, so nothing is summed 1:1.
 */
export type PortfolioCostInput = Pick<
  ExposureLookthroughInput,
  "grossAssets" | "holdings" | "profiles"
> & {
  /**
   * The holdings that are a managed portfolio's undetailed aggregate (#1551) —
   * by MEMBER IDENTITY, from `managedPortfolioMemberRoles`, never by the `other`
   * label they are stored under (#1810). It is money invested in funds nobody
   * enumerated, so without a TER it is the gap, not something that charges none.
   */
  undetailedAggregateIds: ReadonlySet<string>;
};

/**
 * The look-through's three-way coverage in TER words: `declared` carries a TER,
 * `notApplicable` has no fund wrapper to charge one, `undeclared` is a fund whose
 * TER nobody declared (or a managed portfolio's undetailed aggregate, #1810) —
 * the gap, never counted as 0.
 */
export interface PortfolioCostCoverage {
  declared: MoneyMinor;
  notApplicable: MoneyMinor;
  undeclared: MoneyMinor;
}

export interface PortfolioCost {
  /** Σ value × TER over the declared part, rounded once to the minor unit. */
  annualCost: MoneyMinor;
  /** The value-weighted mean TER of the declared part (6 dp), or null with none. */
  weightedTer: DecimalString | null;
  /** The fraction of gross whose TER is declared (4 dp). */
  declaredShare: DecimalString;
  coverage: PortfolioCostCoverage;
}

const WEIGHTED_TER_DECIMALS = 6;
const SHARE_DECIMALS = 4;

/**
 * Price the portfolio's year. A TER the catalog declares is priced whatever the
 * instrument label says — it is a fact about the security, and the label may be
 * wrong (ADR 0109). Without one, a fund wrapper or a managed portfolio's
 * undetailed aggregate (funds nobody enumerated, #1810) is the gap, and anything
 * else has no ongoing charge to declare.
 */
export function portfolioCost(input: PortfolioCostInput): PortfolioCost {
  const currency = input.grossAssets.currency;
  let declaredMinor = 0;
  let undeclaredMinor = 0;
  let notApplicableMinor = 0;
  let annualCost = new Big(0);

  for (const holding of input.holdings) {
    const ter = resolveExposureProfile(holding, input.profiles)?.ter;
    if (ter == null) {
      if (
        FUND_WRAPPER_INSTRUMENTS.has(holding.instrument) ||
        input.undetailedAggregateIds.has(holding.id)
      ) {
        undeclaredMinor += holding.valueMinor;
      } else {
        notApplicableMinor += holding.valueMinor;
      }
      continue;
    }
    declaredMinor += holding.valueMinor;
    annualCost = annualCost.plus(new Big(holding.valueMinor).times(ter));
  }

  return {
    annualCost: { amountMinor: toMinorInt(annualCost), currency },
    coverage: {
      declared: { amountMinor: declaredMinor, currency },
      notApplicable: { amountMinor: notApplicableMinor, currency },
      undeclared: { amountMinor: undeclaredMinor, currency },
    },
    declaredShare: ratioOrZero(declaredMinor, input.grossAssets.amountMinor),
    // A mean over nothing does not exist: printing 0 % would claim a free
    // portfolio when the truth is that no TER is known.
    weightedTer:
      declaredMinor === 0
        ? null
        : divideUnits(
            annualCost.toString(),
            String(declaredMinor),
            WEIGHTED_TER_DECIMALS,
          ),
  };
}

function ratioOrZero(partMinor: number, wholeMinor: number): DecimalString {
  return wholeMinor === 0
    ? "0"
    : divideUnits(String(partMinor), String(wholeMinor), SHARE_DECIMALS);
}
