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
  marketValue?: MoneyMinor;
  unrealizedPnl?: MoneyMinor;
  /** The price per unit used to derive the market value, when one was known. */
  currentPricePerUnit?: DecimalString;
  warnings: string[];
}
