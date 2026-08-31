import type { IrrReason, TwrReason } from "@worthline/domain";

import type { AgentViewDataQualitySeverity } from "./data-quality";
import type { AgentViewExposureCoverage } from "./exposure";
import type { AgentViewMoney } from "./shared";

export interface AgentViewReturnQualitySignal {
  code:
    | "DISTRIBUTIONS_NOT_CAPTURED"
    /** Recorded payouts ARE in the simple gain and the IRR; the TWR is price-only (#657). */
    | "DISTRIBUTIONS_NOT_IN_TWR"
    | "TWR_STARTS_AFTER_FIRST_OPERATION";
  severity: AgentViewDataQualitySeverity;
  label: string;
  firstOperationDate?: string;
  twrStartDate?: string;
}

export interface AgentViewSimpleReturn {
  totalGain: AgentViewMoney;
  totalInvested: AgentViewMoney;
  totalReturnRatio: string | null;
  annualized: boolean;
  cagr: string | null;
  realizedGain?: AgentViewMoney;
  unrealizedGain?: AgentViewMoney;
  /**
   * Recorded distributions over the holding's whole life, folded into `totalGain`
   * (#657, #1627). Present only when the holding received one — the split then
   * closes: `totalGain = realizedGain + unrealizedGain + payoutIncome`. Without
   * this the dividend would sit inside the total with no line to name it, and an
   * assistant asked where the gain comes from would find a hole (#1422).
   */
  payoutIncome?: AgentViewMoney;
}

export interface AgentViewMoneyWeightedReturn {
  rate: string | null;
  reason: IrrReason | null;
}

export interface AgentViewTimeWeightedReturn {
  rate: string | null;
  annualizedRate: string | null;
  annualized: boolean;
  startDate: string | null;
  endDate: string | null;
  reason: TwrReason | null;
}

/**
 * One asset class's blended returns (PRD #552, ADR 0040 fast-follow): the three
 * measures over the fractional, present-time slice every operation-bearing market
 * holding contributes to the class. `key` is an asset-class bucket (`equity`,
 * `bond`, …), `other` (a breakdown's declared-under-100% remainder), or
 * `unclassified` (a holding with no resolvable class). Reference lens, never a
 * figure — a present-time decomposition of the portfolio returns.
 */
export interface AgentViewAssetClassReturns {
  key: string;
  value: AgentViewMoney;
  /**
   * Present (and always `true`) when the class still holds value but not one euro
   * of it in a product of its own (#1458): every euro is a sleeve of a mixed
   * product — «el efectivo rindió un 10,4%» was the pension plans' equity sleeve
   * talking. There are no per-sleeve return series inside a mixed fund, so
   * nothing here can measure this class: the three measures below come back
   * EMPTY (rates null), the way /patrimonio prints em dashes. The blank is
   * enforced where the block is built, not asked of the reader (ADR 0067):
   * `value` and the weight are all there is to quote.
   */
  attributedOnly?: true;
  simple: AgentViewSimpleReturn;
  moneyWeighted: AgentViewMoneyWeightedReturn;
  timeWeighted: AgentViewTimeWeightedReturn;
  /**
   * Present (and always `true`) when the class holds nothing today: it is in the
   * list because it once did (#1456). Its measures still describe a real, closed
   * episode — an eight-day trade annualizes to an alarming rate that says nothing
   * about today's portfolio — so read it as history, never as present weight.
   */
  closed?: true;
}

/**
 * Per-asset-class returns for the portfolio (PRD #552): one entry per class the
 * operation-bearing market holdings resolve to, plus the three-way coverage of
 * attributed value (asset class has no `notApplicable`, so it splits classified
 * vs unknown). Present only on the portfolio returns block — a single holding has
 * one class, not a breakdown.
 */
export interface AgentViewAssetClassReturnsBlock {
  classes: AgentViewAssetClassReturns[];
  coverage: AgentViewExposureCoverage;
}

export interface AgentViewReturns {
  simple: AgentViewSimpleReturn;
  moneyWeighted: AgentViewMoneyWeightedReturn;
  timeWeighted: AgentViewTimeWeightedReturn;
  qualitySignals: AgentViewReturnQualitySignal[];
  /** Present-time per-asset-class decomposition (portfolio block only, PRD #552). */
  byAssetClass?: AgentViewAssetClassReturnsBlock;
}
