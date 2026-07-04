import type { CurrencyCode, MoneyMinor } from "./money";
import type { DecimalString } from "./decimal";

export type OperationKind = "buy" | "sell";

/** A single buy or sell against a unit-based (investment) asset. */
export interface InvestmentOperation {
  id: string;
  assetId: string;
  kind: OperationKind;
  executedAt: string;
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor: number;
}

export interface CreateInvestmentOperationInput {
  id: string;
  assetId: string;
  kind: OperationKind;
  executedAt: string;
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor?: number;
}

/** Derived state of a unit-based asset after folding its operations. */
export interface PositionSummary {
  assetId: string;
  currency: CurrencyCode;
  currentUnits: DecimalString;
  costBasis: MoneyMinor;
  averageUnitCost: DecimalString;
  /**
   * Realized P/L accumulated across sells: proceeds (net of fees) minus the cost
   * basis of the units sold, at the running weighted average (#548, ADR 0040).
   * Always present — it derives from the operation ledger alone, independent of
   * whether a current price is known.
   */
  realizedPnl: MoneyMinor;
  marketValue?: MoneyMinor;
  unrealizedPnl?: MoneyMinor;
  /** The price per unit used to derive the market value, when one was known. */
  currentPricePerUnit?: DecimalString;
  warnings: string[];
}
