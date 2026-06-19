/**
 * Declarative persona specs (PRD #297, ADR 0023). A spec is pure data — no store
 * calls — interpreted by {@link seedPersona}. Every date is expressed RELATIVE to
 * the pinned demo clock (`yearsAgo`/`monthsAgo`/`daysAgo`), so each persona's
 * history regenerates correctly whenever the demo's "now" is bumped.
 *
 * Money is integer minor units; rates/prices/units are decimal strings; ownership
 * shares are basis points (10_000 = 100%).
 */
import type {
  CurrencyCode,
  DecimalString,
  FireScopeConfig,
  LiquidityTier,
  Member,
  OwnershipShare,
  WorkspaceMode,
} from "@worthline/domain";

import type { PersonaId } from "@web/demo/persona";

/** A date expressed as an offset before the pinned "now". Zero/empty = today. */
export interface RelativeDate {
  yearsAgo?: number;
  monthsAgo?: number;
  daysAgo?: number;
}

/** A cash / "other" manual asset (no derived valuation). */
export interface ManualAssetSpec {
  id: string;
  name: string;
  /** "cash" for liquid/term deposits, "manual" for illiquid possessions. */
  type: "cash" | "manual";
  liquidityTier: LiquidityTier;
  valueMinor: number;
  ownership: OwnershipShare[];
  currency?: CurrencyCode;
}

export interface OperationSpec {
  id: string;
  kind: "buy" | "sell";
  at: RelativeDate;
  units: DecimalString;
  pricePerUnit: DecimalString;
  feesMinor?: number;
}

/** A derived investment (value always rolled from its operations, ADR 0006). */
export interface InvestmentSpec {
  id: string;
  name: string;
  ownership: OwnershipShare[];
  manualPricePerUnit: DecimalString;
  unitSymbol?: string;
  liquidityTier?: LiquidityTier;
  currency?: CurrencyCode;
  operations: OperationSpec[];
}

export interface ValuationAnchorSpec {
  id: string;
  at: RelativeDate;
  valueMinor: number;
}

export interface EarlyRepaymentSpec {
  id: string;
  at: RelativeDate;
  amountMinor: number;
  mode: "reduce-payment" | "reduce-term";
}

/** An amortizable mortgage securing a housing asset (ADR 0019 two dates). */
export interface MortgageSpec {
  liabilityId: string;
  planId: string;
  name: string;
  ownership: OwnershipShare[];
  initialCapitalMinor: number;
  annualInterestRate: DecimalString;
  termMonths: number;
  disbursement: RelativeDate;
  firstPayment: RelativeDate;
  earlyRepayments?: EarlyRepaymentSpec[];
}

/** A real-estate holding with an acquisition anchor, appreciation, improvements. */
export interface HousingSpec {
  id: string;
  name: string;
  ownership: OwnershipShare[];
  isPrimaryResidence?: boolean;
  currency?: CurrencyCode;
  liquidityTier?: LiquidityTier;
  acquisition: { at: RelativeDate; valueMinor: number };
  annualAppreciationRate?: DecimalString;
  /** Increments to the curve (adjustsPriorCurve = false). */
  improvements?: ValuationAnchorSpec[];
  mortgage?: MortgageSpec;
}

export interface BalanceAnchorSpec {
  id: string;
  at: RelativeDate;
  balanceMinor: number;
}

/** A standalone (non-mortgage) liability — a loan or revolving credit. */
export interface LiabilitySpec {
  id: string;
  name: string;
  ownership: OwnershipShare[];
  balanceMinor: number;
  currency?: CurrencyCode;
  model?: "revolving" | "informal";
  balanceAnchors?: BalanceAnchorSpec[];
}

export interface FireSpec {
  scopeId: string;
  config: FireScopeConfig;
}

export interface PersonaSpec {
  id: PersonaId;
  mode: WorkspaceMode;
  members: Member[];
  manualAssets?: ManualAssetSpec[];
  investments?: InvestmentSpec[];
  housing?: HousingSpec[];
  liabilities?: LiabilitySpec[];
  fire?: FireSpec[];
}
