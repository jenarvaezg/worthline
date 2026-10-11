import Big from "big.js";

import type { DecimalString } from "./decimal";
import { divideUnits, toMinorInt } from "./decimal";
import {
  type ExposureCoverage,
  type ExposureLookthroughHolding,
  type ExposureProfile,
  resolveExposureProfile,
} from "./exposure-lookthrough";
import type { Instrument } from "./instrument-catalog";
import type { MoneyMinor } from "./money";

/**
 * Lo que la cartera cuesta (#1717): the value-weighted mean TER and its reading
 * in money per year (Σ value × TER), a lens derived from the exposure catalog like
 * geography or currency — never a figure the math reads.
 *
 * THE invariant: no return reads a TER. A fund's net asset value is already net
 * of its ongoing charges, so subtracting the TER from a rentabilidad would charge
 * it twice. This module is the only consumer of `ExposureProfile.ter`, and
 * `portfolio-cost.guardian.test.ts` keeps every returns module from reaching it.
 */

/** One holding the lens prices: its catalog identity and its value. */
export interface PortfolioCostHolding
  extends Pick<
    ExposureLookthroughHolding,
    "id" | "instrument" | "securityId" | "providerSymbol"
  > {
  /**
   * Already in the gross currency: a foreign holding crosses the FX layer (#1065)
   * before it reaches this lens — it is never summed 1:1.
   */
  value: MoneyMinor;
}

export interface PortfolioCostInput {
  grossAssets: MoneyMinor;
  holdings: readonly PortfolioCostHolding[];
  profiles: ReadonlyMap<string, ExposureProfile>;
}

export interface PortfolioCost {
  /** Σ value × TER over the declared part, rounded once to the minor unit. */
  annualCost: MoneyMinor;
  /** The value-weighted mean TER of the declared part (6 dp), or null with none. */
  weightedTer: DecimalString | null;
  /** The fraction of gross whose TER is declared (4 dp). */
  declaredShare: DecimalString;
  /**
   * The look-through's three-way split: `classified` carries a declared TER,
   * `notApplicable` has no fund wrapper to charge one, `unknown` is a fund
   * whose TER nobody declared — the gap, never counted as 0.
   */
  coverage: ExposureCoverage;
}

/**
 * The instruments that wrap a portfolio and charge for running it. Without a
 * declared TER one of these is the gap; anything else — cash, property, crypto,
 * metals, coins and a directly held share — has no ongoing charge to declare and
 * is not applicable. A TER the catalog DOES declare is priced whatever the
 * instrument says: it is a fact about the security, and the label may be wrong.
 */
const FUND_WRAPPER_INSTRUMENTS: ReadonlySet<Instrument> = new Set<Instrument>([
  "fund",
  "etf",
  "index",
  "pension_plan",
]);

const WEIGHTED_TER_DECIMALS = 6;
const SHARE_DECIMALS = 4;

export function portfolioCost(input: PortfolioCostInput): PortfolioCost {
  const currency = input.grossAssets.currency;
  let declaredMinor = 0;
  let undeclaredMinor = 0;
  let notApplicableMinor = 0;
  let annualCost = new Big(0);

  for (const holding of input.holdings) {
    if (holding.value.currency !== currency) {
      throw new Error(
        `Portfolio cost: holding ${holding.id} is valued in ${holding.value.currency}, not ${currency}; convert it through the FX layer first.`,
      );
    }
    const ter = resolveExposureProfile(holding, input.profiles)?.ter;
    if (ter == null) {
      if (FUND_WRAPPER_INSTRUMENTS.has(holding.instrument)) {
        undeclaredMinor += holding.value.amountMinor;
      } else {
        notApplicableMinor += holding.value.amountMinor;
      }
      continue;
    }
    declaredMinor += holding.value.amountMinor;
    annualCost = annualCost.plus(new Big(holding.value.amountMinor).times(ter));
  }

  return {
    annualCost: { amountMinor: toMinorInt(annualCost), currency },
    coverage: {
      classified: { amountMinor: declaredMinor, currency },
      notApplicable: { amountMinor: notApplicableMinor, currency },
      unknown: { amountMinor: undeclaredMinor, currency },
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
