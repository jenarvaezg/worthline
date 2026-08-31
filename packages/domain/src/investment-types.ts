import type { CostBasisGrade } from "./cost-basis-grade";
import type { Instant } from "./dates";
import type { DecimalString } from "./decimal";
import type { CurrencyCode, MoneyMinor } from "./money";

/**
 * What an operation does to a position. Four kinds, not two: a **traspaso** — the
 * Spanish fund-to-fund transfer that moves capital between products without a
 * taxable event — is its own pair of kinds rather than a sell plus a buy (#1393).
 *
 * Why kinds and not a flag on `sell`: a `sell` carrying a `transferId` would make
 * every fold that must NOT realize a gain remember to look at that column —
 * opt-out semantics, fail-open. With their own kinds, TypeScript refuses to
 * compile a fold that has not said what it does with them.
 */
export type OperationKind = "buy" | "sell" | "transfer_out" | "transfer_in";
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
  /**
   * The id shared by the two halves of one traspaso, present on both and on nothing
   * else (#1393). It is what lets a reader pair them; `batchId` cannot serve, since
   * it groups a whole import and is not exclusive to the pair.
   */
  transferId?: string;
  /**
   * The acquisition cost the incoming units carry over from the origin, in minor
   * units — present ONLY on a `transfer_in`.
   *
   * It is persisted on the row rather than recomputed by crossing over to the origin
   * at fold time, because `derivePosition` folds the ledger of ONE asset and
   * that purity is what makes it testable. The origin computes it once, when the pair
   * is written; from then on the destination's cost basis is a fact of its own ledger.
   * Same shape as the `capture` columns of #1401.
   */
  transferCostMinor?: number;
  /**
   * The day the capital this row brought in started counting its age, when the user
   * declared it — present only on a `transfer_in`, and in practice only on an
   * external one, because only its doors ask (#1518).
   *
   * A movilización between institutions carries the seniority of the aportaciones
   * that funded it, and `executedAt` is the day it LANDED, not the day it was
   * earned. Reading age off the row would say «bloqueado hasta 2035» about money
   * that may be rescatable today, which is why it is DECLARED and never derived:
   * the aportaciones are in another institution's ledger.
   *
   * Nothing reads it yet — #1528 builds partial liquidity on top. It is stored now
   * because the door is the only moment the user has the old provider's paperwork
   * in front of them; a column added later would face a book that can no longer
   * learn the answer.
   */
  transferSeniorityAt?: string;
  /**
   * How honest this row's price is as a COST (#1505). Absent on a real dated
   * movement, whose price IS its cost — and on every row written before #1505,
   * aperturas included; see {@link CostBasisGrade} and the v65 migration.
   */
  costBasisGrade?: CostBasisGrade;
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
  /** The id tying this row to the other half of its traspaso (#1393). */
  transferId?: string;
  /** Inherited acquisition cost in minor units, on a `transfer_in` only (#1393). */
  transferCostMinor?: number;
  /** Declared inherited seniority, on a `transfer_in` only (#1518). */
  transferSeniorityAt?: string;
  /**
   * The grade of the cost this row states (#1505) — written ONLY by a door that
   * knows the answer, which today is the alta stamping `source: "opening"`.
   */
  costBasisGrade?: CostBasisGrade;
}

/** Machine code for a clamp in {@link derivePosition}: a sell or traspaso past what is held. */
export type PositionWarningCode = "OVERSELL" | "OVER_TRANSFER";

/** A coded, overrideable clamp from the position fold (#1443). */
export interface PositionWarning {
  code: PositionWarningCode;
  message: string;
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
   * Its OWN field, not a `warnings` entry: coded oversell/over-transfer clamps live
   * on {@link PositionSummary.warnings}, and the statement importer keys the
   * «venta excede posición» flag off those codes (#1443). A currency problem posted
   * there would still be the wrong grade of news.
   */
  currencyWarning?: string;
  /**
   * The grade of the cost basis this fold arrived at (#1505): the LEAST honest
   * grade among the operations still contributing to it, or absent when every
   * contribution is a real movement.
   *
   * Its own field for the same reason {@link PositionSummary.currencyWarning} has
   * one: `warnings` is a channel whose consumers read any entry as an over-sell
   * (#1443), and a cost nobody declared is a different grade of news — the figures
   * are not clamped, they are un-affirmable.
   */
  costBasisGrade?: CostBasisGrade;
  /** The price per unit used to derive the market value, when one was known. */
  currentPricePerUnit?: DecimalString;
  warnings: PositionWarning[];
}
