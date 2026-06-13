/**
 * Instrument catalog (#149, ADR 0014).
 *
 * An **instrument** is *what* a holding is (a fund, a property, a mortgage…),
 * independent of *how* it is valued (its valuation method) or *where* it sits on
 * the liquidity ladder. This module owns the instrument vocabulary and the single
 * defaults table: `defaultsFor(instrument)` returns the rung, valuation method and
 * default price provider an instrument suggests — replacing defaults that were
 * scattered across the codebase (provider-by-tier, the forced real_estate→housing).
 */

import type { ValuationMethod } from "./holding-valuation";
import type { LiquidityTier } from "./liquidity-ladder";
import type { InvestmentPriceProvider } from "./prices";
import type { AssetType, DebtModel, LiabilityType } from "./workspace-types";

/** The price provider an instrument defaults to. `coingecko` is the crypto hint. */
export type InstrumentPriceProvider = InvestmentPriceProvider | "coingecko";

/** What a holding is (ADR 0014). */
export type Instrument =
  | "current_account"
  | "term_deposit"
  | "fund"
  | "etf"
  | "stock"
  | "index"
  | "pension_plan"
  | "crypto"
  | "precious_metal"
  | "vehicle"
  | "property"
  | "mortgage"
  | "loan"
  | "credit_card"
  | "other";

/** The defaults an instrument suggests. */
export interface InstrumentDefaults {
  /** The liquidity-ladder rung this instrument suggests (overridable). */
  rung: LiquidityTier;
  /** How this instrument is valued (ADR 0014). */
  valuationMethod: ValuationMethod;
  /** The default price provider, when the instrument is priced by one. */
  priceProvider?: InstrumentPriceProvider;
}

const INSTRUMENT_DEFAULTS: Record<Instrument, InstrumentDefaults> = {
  // Stored — valued by hand.
  current_account: { rung: "cash", valuationMethod: "stored" },
  term_deposit: { rung: "term-locked", valuationMethod: "stored" },
  precious_metal: { rung: "illiquid", valuationMethod: "stored" },
  vehicle: { rung: "illiquid", valuationMethod: "stored" },
  other: { rung: "illiquid", valuationMethod: "stored" },
  // Derived — units × price; the provider feeds the price.
  fund: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
  etf: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
  stock: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
  index: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
  pension_plan: {
    rung: "term-locked",
    valuationMethod: "derived",
    priceProvider: "finect",
  },
  crypto: { rung: "market", valuationMethod: "derived", priceProvider: "coingecko" },
  // Appreciating — revaluation curve + appraisals.
  property: { rung: "illiquid", valuationMethod: "appreciating" },
  // Debt instruments. A standalone liability lands on `cash` (rungForLiability);
  // a mortgage secures property, so it suggests `illiquid`.
  mortgage: { rung: "illiquid", valuationMethod: "amortized" },
  loan: { rung: "cash", valuationMethod: "amortized" },
  credit_card: { rung: "cash", valuationMethod: "anchored" },
};

/** The defaults for an instrument — its rung, valuation method and price provider. */
export function defaultsFor(instrument: Instrument): InstrumentDefaults {
  return INSTRUMENT_DEFAULTS[instrument];
}

/** Provider quote types we recognize when prefilling from a symbol search (#139). */
const QUOTE_TYPE_TO_INSTRUMENT: Record<string, Instrument> = {
  MUTUALFUND: "fund",
  ETF: "etf",
  EQUITY: "stock",
  INDEX: "index",
  PENSIONPLAN: "pension_plan",
};

/**
 * The instrument a symbol-search candidate's provider quote type suggests (#139):
 * Yahoo's MUTUALFUND/ETF/EQUITY/INDEX and Finect's PENSIONPLAN.
 */
export function instrumentForQuoteType(quoteType: string | undefined): Instrument {
  if (quoteType && quoteType in QUOTE_TYPE_TO_INSTRUMENT) {
    return QUOTE_TYPE_TO_INSTRUMENT[quoteType]!;
  }
  return "other";
}

/**
 * The instrument an asset backfills to from its legacy `AssetType` (#149). A
 * primary residence is a `property` whatever its type — mirroring the old
 * `isHousingAsset` rule (real_estate OR primary residence) so housing equity stays
 * byte-identical when re-sourced from the instrument. The investment→`fund`
 * default is the coarse fallback; the migration refines it via the price provider
 * (finect→pension_plan), and new investments resolve via `instrumentForQuoteType`.
 */
export function defaultInstrumentForAssetType(
  type: AssetType,
  isPrimaryResidence: boolean,
): Instrument {
  if (isPrimaryResidence) return "property";
  switch (type) {
    case "real_estate":
      return "property";
    case "cash":
      return "current_account";
    case "investment":
      return "fund";
    case "manual":
      return "other";
  }
}

/**
 * The instrument a liability backfills to from its type + debt model (#149). A
 * mortgage stays a `mortgage`; a revolving debt is a `credit_card`; every other
 * debt is a `loan`. The instrument is forward-prep for liabilities in this slice
 * (only `property` is read, for housing) — valuation still flows through the debt
 * model, so an `informal` debt mapping to `loan` changes no figure.
 */
export function defaultInstrumentForLiability(
  type: LiabilityType,
  debtModel: DebtModel | null,
): Instrument {
  if (type === "mortgage") return "mortgage";
  return debtModel === "revolving" ? "credit_card" : "loan";
}
