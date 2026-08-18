import type { Instant } from "./dates";
import type { DecimalString } from "./decimal";
import type { CurrencyCode, MoneyMinor } from "./money";

export type OperationKind = "buy" | "sell";
export type OperationSource = "manual" | "opening" | "statement" | "connected" | "agent";

/**
 * The pre-conversion apunte: what the user actually saw on the statement. Present
 * ONLY on an operation captured outside EUR, so its absence is the honest reading
 * "this was always euros" rather than "the original was lost".
 *
 * Why keep it at all, when `executedAt` is enough to re-fetch the rate: it is what
 * lets the ficha read the operation back in the currency the bank stated it in, and
 * it pins the conversion to the rate that was actually applied — an ECB revision, or
 * a carry-forward window that resolves differently later, must not silently rewrite
 * a cost basis that has already rippled through every snapshot.
 */
export interface OperationCapture {
  /** The currency the apunte was captured in. Never EUR (the base currency). */
  currency: CurrencyCode;
  /** The unit price as stated, in {@link OperationCapture.currency}. */
  pricePerUnit: DecimalString;
  /** The fees as stated, in {@link OperationCapture.currency}'s minor units. */
  feesMinor: number;
  /**
   * EUR per one unit of {@link OperationCapture.currency}, the rate applied — dated
   * to the execution day (or the business day it carried forward from).
   */
  eurPerUnit: number;
}

/** A single buy or sell against a unit-based (investment) asset. */
export interface InvestmentOperation {
  id: string;
  assetId: string;
  kind: OperationKind;
  executedAt: string;
  /** Optional source instant, normalized to UTC. Same-day ordering uses this before id. */
  occurredAt?: Instant;
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor: number;
  source?: OperationSource;
  /**
   * The apunte before conversion, when it was captured outside EUR (#1401). Absent
   * on a euro operation — see {@link OperationCapture}.
   */
  capture?: OperationCapture;
}

export interface CreateInvestmentOperationInput {
  id: string;
  assetId: string;
  kind: OperationKind;
  executedAt: string;
  /** Importer/connector source instant. Manual and date-only imports leave it absent. */
  occurredAt?: string;
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor?: number;
  source?: OperationSource;
  /** Set by `convertOperationToBaseCurrency`; never built by a caller (#1401). */
  capture?: OperationCapture;
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
  /**
   * Set when the folded operations are not all in {@link PositionSummary.currency}, so
   * the summed cost cannot be trusted (#1401).
   *
   * Its OWN field, not a `warnings` entry: `warnings` has one consumer and it reads any
   * entry as an over-sell (`statement-import-preview.ts` → «venta excede posición»), so
   * a currency problem posted there would be reported to the user as a bad sell. These
   * are different grades of news — one is about the operation being previewed, the other
   * about the integrity of what is already stored.
   */
  currencyWarning?: string;
  /** The price per unit used to derive the market value, when one was known. */
  currentPricePerUnit?: DecimalString;
  warnings: string[];
}
