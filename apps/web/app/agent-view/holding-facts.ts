import type {
  AgentViewReadStore,
  AmortizationPlanRecord,
  BalanceAnchorRecord,
  EarlyRepaymentRecord,
  InterestRateRevisionRecord,
  ValuationAnchorRecord,
} from "@worthline/db";
import type { DebtModel } from "@worthline/domain";

import type {
  AgentViewAmortizationFacts,
  AgentViewBalanceAnchorFacts,
  AgentViewBalanceInterpolation,
  AgentViewHoldingFactsState,
  AgentViewMoney,
  AgentViewValuationAnchor,
} from "./contract";
import { derivePublicId } from "./derived-id";

/**
 * The calculation-fact blocks for one holding, plus the documented fact-state
 * marker (PRD #328, #338). The blocks are mutually exclusive by direction —
 * `valuationAnchors` for an appreciating asset, `amortization`/`balanceAnchors`
 * for a liability — so a single holding ever carries at most one block. `state`
 * is set only when a holding cannot honestly produce the facts its valuation
 * method needs (a configured method missing its data → `missing_configuration`;
 * a method with no dated facts at all → `unsupported`).
 */
export interface HoldingFacts {
  valuationAnchors?: AgentViewValuationAnchor[];
  amortization?: AgentViewAmortizationFacts;
  balanceAnchors?: AgentViewBalanceAnchorFacts;
  state?: AgentViewHoldingFactsState;
}

/**
 * Assemble an appreciating asset's valuation-anchor facts (#338). An appreciating
 * asset with no anchors surfaces `missing_configuration` rather than a fabricated
 * curve. Any other asset method (stored / derived) carries no dated valuation
 * facts at all, so it surfaces neither a block nor a marker — the absence is the
 * signal, not a defect to flag.
 */
export async function assetHoldingFacts(
  store: AgentViewReadStore,
  assetId: string,
  valuationMethod: string,
  currency: string,
): Promise<HoldingFacts> {
  if (valuationMethod !== "appreciating") {
    return {};
  }

  const anchors = await store.readValuationAnchors(assetId);
  if (anchors.length === 0) {
    return { state: "missing_configuration" };
  }

  return {
    valuationAnchors: anchors.map((anchor) => toValuationAnchor(anchor, currency)),
  };
}

/**
 * Assemble a liability's calculation facts (#338). An amortized liability exposes
 * its plan + revisions + early repayments; an anchored liability its balance
 * anchors and interpolation semantics. A method configured but missing its data
 * (amortized with no plan, anchored with no anchors) surfaces
 * `missing_configuration`. A liability whose instrument expects debt facts
 * (`amortized`/`anchored`) but has no debt model configured presents as needing
 * facts it cannot produce → `unsupported`; a genuinely stored liability (no
 * facts expected) carries no marker.
 */
export async function liabilityHoldingFacts(
  store: AgentViewReadStore,
  liabilityId: string,
  expectedValuationMethod: string,
  currency: string,
): Promise<HoldingFacts> {
  const debtModel = await store.readDebtModel(liabilityId);

  if (debtModel === "amortizable") {
    return amortizationFacts(store, liabilityId, currency);
  }

  if (debtModel === "revolving" || debtModel === "informal") {
    return balanceAnchorFacts(store, liabilityId, debtModel, currency);
  }

  // No debt model. If the instrument default expects debt facts, the holding is
  // configured to need facts it cannot produce; otherwise it is a plain stored
  // balance with no dated facts.
  if (expectedValuationMethod === "amortized" || expectedValuationMethod === "anchored") {
    return { state: "unsupported" };
  }

  return {};
}

async function amortizationFacts(
  store: AgentViewReadStore,
  liabilityId: string,
  currency: string,
): Promise<HoldingFacts> {
  const plan = await store.readAmortizationPlan(liabilityId);
  if (!plan) {
    return { state: "missing_configuration" };
  }

  const revisions = await store.readInterestRateRevisions(plan.id);
  const repayments = await store.readEarlyRepayments(plan.id);

  return {
    amortization: {
      earlyRepayments: repayments.map((repayment) =>
        toEarlyRepayment(repayment, currency),
      ),
      interestRateRevisions: revisions.map(toInterestRateRevision),
      plan: toAmortizationPlan(plan, currency),
    },
  };
}

async function balanceAnchorFacts(
  store: AgentViewReadStore,
  liabilityId: string,
  debtModel: Exclude<DebtModel, "amortizable">,
  currency: string,
): Promise<HoldingFacts> {
  const anchors = await store.readBalanceAnchors(liabilityId);
  if (anchors.length === 0) {
    return { state: "missing_configuration" };
  }

  return {
    balanceAnchors: {
      anchors: anchors.map((anchor) => toBalanceAnchor(anchor, currency)),
      interpolation: interpolationFor(debtModel),
    },
  };
}

/**
 * How an anchored liability reads its balance between anchors (debt-balance.ts):
 * revolving interpolates linearly by calendar days; informal is a step function
 * holding the last anchor on or before a date. Exposed as documented semantics,
 * never as a guessed intermediate value.
 */
function interpolationFor(
  debtModel: Exclude<DebtModel, "amortizable">,
): AgentViewBalanceInterpolation {
  return debtModel === "revolving" ? "linear" : "step";
}

function toValuationAnchor(
  anchor: ValuationAnchorRecord,
  currency: string,
): AgentViewValuationAnchor {
  return {
    date: anchor.valuationDate,
    id: derivePublicId("van", anchor.id),
    kind: anchor.adjustsPriorCurve ? "market_appraisal" : "improvement",
    object: "valuation_anchor",
    value: money(anchor.valueMinor, currency),
  };
}

function toAmortizationPlan(plan: AmortizationPlanRecord, currency: string) {
  return {
    annualInterestRate: plan.annualInterestRate,
    disbursementDate: plan.disbursementDate,
    firstPaymentDate: plan.firstPaymentDate,
    id: derivePublicId("amp", plan.id),
    initialCapital: money(plan.initialCapitalMinor, currency),
    object: "amortization_plan" as const,
    termMonths: plan.termMonths,
  };
}

function toInterestRateRevision(revision: InterestRateRevisionRecord) {
  return {
    annualInterestRate: revision.newAnnualInterestRate,
    date: revision.revisionDate,
    id: derivePublicId("irr", revision.id),
    object: "interest_rate_revision" as const,
  };
}

function toEarlyRepayment(repayment: EarlyRepaymentRecord, currency: string) {
  return {
    amount: money(repayment.amountMinor, currency),
    date: repayment.repaymentDate,
    id: derivePublicId("erp", repayment.id),
    mode: repayment.mode,
    object: "early_repayment" as const,
  };
}

function toBalanceAnchor(anchor: BalanceAnchorRecord, currency: string) {
  return {
    balance: money(anchor.balanceMinor, currency),
    date: anchor.anchorDate,
    id: derivePublicId("ban", anchor.id),
    object: "balance_anchor" as const,
  };
}

function money(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}
