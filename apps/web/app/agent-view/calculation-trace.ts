import type { AgentViewReadStore } from "@worthline/db";
import type {
  AmortizationPlanInput,
  BalanceRebaselineInput,
  EarlyRepayment,
  InterestRateRevision,
  Workspace,
} from "@worthline/domain";
import {
  amortizationScheduleTrace,
  deriveMonthlyCloses,
  effectiveAmortizationPlan,
  listScopeOptions,
  projectPortfolio,
  systemClock,
} from "@worthline/domain";

import {
  type AgentViewAmortizationSchedule,
  type AgentViewAmortizationScheduleEvent,
  type AgentViewBalanceAnchorFacts,
  type AgentViewBalanceInterpolation,
  type AgentViewCalculationTrace,
  type AgentViewCalculationTraceFidelity,
  type AgentViewCalculationTraceModel,
  type AgentViewCalculationTracePoint,
  type AgentViewCalculationTraceTolerance,
  AgentViewHttpError,
  type AgentViewMoney,
} from "./contract";
import { derivePublicId } from "./derived-id";
import { resolveInternalHoldingId } from "./scope-resolution";

/** The internal household scope id (the unscoped, full-ownership view). */
const HOUSEHOLD_SCOPE_ID = "household";

/**
 * The modeling-tolerance floor: differences under 1 € read as rounding/modeling
 * friction, never a real error (PRD #1048/#1049). Documented as a constant so the
 * band is auditable and the agent never invents its own threshold.
 */
export const MODELING_TOLERANCE_FLOOR_MINOR = 100;

/** The modeling-tolerance rate: 0.05 % of the outstanding balance (PRD #1048/#1049). */
export const MODELING_TOLERANCE_RATE = 0.0005;

/**
 * The most recent persisted snapshots reconciled against the live curve. The
 * trace values the whole ledger once per point, so it is bounded rather than
 * walking an unbounded history; anything dropped is reported in
 * `omittedReconciliationPoints`, never silently.
 */
export const MAX_RECONCILIATION_SNAPSHOTS = 36;

/** A divergence must exceed one cent to count — never a scope-weighting rounding artifact. */
const DIVERGENCE_EPSILON_MINOR = 1;

export interface BuildCalculationTraceOptions {
  /** Valuation date; defaults to the system clock's today. */
  asOf?: string;
  /** A user-declared balance (integer minor units) to run the modeling-tolerance verdict against. */
  declaredBalanceMinor?: number;
  /** The date the declared figure describes; defaults to `asOf`. */
  declaredDate?: string;
}

/**
 * Assemble the calculation trace for a modelled debt holding (PRD #1048 S1,
 * #1049). Reads persisted state only — it recomputes balances through the live
 * curve (`readCurveValuedHoldings` + `projectPortfolio`, the same path the
 * dashboard figure uses) but never captures, refreshes, or ripples. Scoped to
 * liabilities with a configured debt model; anything else is a documented 422.
 */
export async function buildCalculationTrace(
  store: AgentViewReadStore,
  publicHoldingId: string,
  options: BuildCalculationTraceOptions = {},
): Promise<AgentViewCalculationTrace> {
  const workspace = await store.readWorkspace();
  if (!workspace) {
    throw unknownHolding();
  }

  const asOf = options.asOf ?? systemClock().today();
  const internalHoldingId = await resolveInternalHoldingId(store, publicHoldingId);
  const currency = workspace.baseCurrency;
  const scope = householdScope(workspace);

  // The holding must be a liability with a configured debt model. An asset, or a
  // liability with no model, has no engine cuadro to trace in v1 — reported
  // honestly, never faked.
  const liability = (await store.readLiabilities()).find(
    (candidate) => candidate.id === internalHoldingId,
  );
  const debtModel = await store.readDebtModel(internalHoldingId);
  if (debtModel === null) {
    throw new AgentViewHttpError({
      code: "unprocessable_entity",
      message: liability
        ? "This liability has no debt model configured, so it has no calculation trace."
        : "The calculation trace is available only for debt holdings with a debt model.",
      status: 422,
    });
  }

  // Whether the household holds any share of this liability. `projectPortfolio`
  // drops a row whose scoped value rounds to 0, so a null projection row is
  // ambiguous: a paid-off debt (balance 0, still traceable) vs a holding the
  // household does not own (404). This disambiguates the two.
  const memberIds = new Set(workspace.members.map((member) => member.id));
  const ownedByHousehold =
    liability?.ownership.some(
      (share) => memberIds.has(share.memberId) && share.shareBps > 0,
    ) ?? false;

  const liveAt = async (date: string): Promise<number | null> => {
    const { assets, liabilities } = await store.readCurveValuedHoldings(date);
    const projection = projectPortfolio({ assets, liabilities, scope, workspace });
    const row = projection.sections[1].rows.find((r) => r.id === internalHoldingId);
    // A missing row on an owned liability is a genuine zero balance (the debt is
    // paid off on `date`); on an unowned holding it is "not in scope" → null.
    if (row) return row.balanceMinor;
    return ownedByHousehold ? 0 : null;
  };

  const currentBalanceMinor = await liveAt(asOf);
  if (currentBalanceMinor === null) {
    // The holding exists in the registry but the household scope does not own it.
    throw unknownHolding();
  }

  const { reconciliation, omitted } = await buildReconciliation({
    asOf,
    currentBalanceMinor,
    currency,
    internalHoldingId,
    liveAt,
    store,
  });

  const schedule =
    debtModel === "amortizable"
      ? await buildSchedule(store, internalHoldingId, currency, asOf)
      : undefined;
  const balanceAnchors =
    debtModel === "amortizable"
      ? undefined
      : await buildBalanceAnchors(store, internalHoldingId, debtModel, currency);

  return {
    asOf,
    currentValue: money(currentBalanceMinor, currency),
    direction: "liability",
    fidelity: fidelityFrom(reconciliation),
    holding: publicHoldingId,
    model: debtModel satisfies AgentViewCalculationTraceModel,
    object: "calculation_trace",
    omittedReconciliationPoints: omitted,
    reconciliation,
    tolerance: await buildTolerance({
      asOf,
      currency,
      currentBalanceMinor,
      liveAt,
      ...(options.declaredBalanceMinor === undefined
        ? {}
        : { declaredBalanceMinor: options.declaredBalanceMinor }),
      ...(options.declaredDate === undefined
        ? {}
        : { declaredDate: options.declaredDate }),
    }),
    ...(schedule ? { schedule } : {}),
    ...(balanceAnchors ? { balanceAnchors } : {}),
  };
}

/**
 * Reconcile the live curve against every recent persisted snapshot of this
 * holding, plus a current-date row. Each point weights the balance for the
 * household exactly as the dashboard does, so a divergence is a real config /
 * ripple mismatch, not a scope-weighting artifact.
 */
async function buildReconciliation(input: {
  store: AgentViewReadStore;
  internalHoldingId: string;
  currency: string;
  asOf: string;
  currentBalanceMinor: number;
  liveAt: (date: string) => Promise<number | null>;
}): Promise<{ reconciliation: AgentViewCalculationTracePoint[]; omitted: number }> {
  const snapshots = await input.store.readSnapshots(HOUSEHOLD_SCOPE_ID);
  const dateBySnapshotId = new Map(snapshots.map((s) => [s.id, s.dateKey]));
  const closeIds = new Set(deriveMonthlyCloses(snapshots).values());

  // The frozen (persisted, household-weighted) balance of this holding per date.
  const rows = await input.store.readSnapshotHoldings({ scopeId: HOUSEHOLD_SCOPE_ID });
  const persistedByDate = new Map<string, number>();
  for (const row of rows) {
    if (row.holdingId !== input.internalHoldingId) continue;
    const date = dateBySnapshotId.get(row.snapshotId);
    if (date === undefined || !closeIds.has(row.snapshotId)) {
      continue;
    }
    persistedByDate.set(date, row.valueMinor);
  }

  const persistedDates = [...persistedByDate.keys()]
    .filter((date) => date !== input.asOf)
    .sort();
  const omitted = Math.max(0, persistedDates.length - MAX_RECONCILIATION_SNAPSHOTS);
  const selected = persistedDates.slice(-MAX_RECONCILIATION_SNAPSHOTS);

  const snapshotPoints = await Promise.all(
    selected.map(async (date) =>
      toPoint({
        currency: input.currency,
        date,
        isSnapshot: true,
        liveMinor: await input.liveAt(date),
        persistedMinor: persistedByDate.get(date) ?? null,
      }),
    ),
  );

  // The always-present current-date row: live is the painted figure; persisted is
  // today's frozen snapshot when one exists.
  const currentPoint = toPoint({
    currency: input.currency,
    date: input.asOf,
    isSnapshot: false,
    liveMinor: input.currentBalanceMinor,
    persistedMinor: persistedByDate.get(input.asOf) ?? null,
  });

  return { omitted, reconciliation: [...snapshotPoints, currentPoint] };
}

function toPoint(input: {
  date: string;
  liveMinor: number | null;
  persistedMinor: number | null;
  isSnapshot: boolean;
  currency: string;
}): AgentViewCalculationTracePoint {
  const liveMinor = input.liveMinor ?? 0;
  const hasPersisted = input.persistedMinor !== null;
  const differenceMinor = hasPersisted ? liveMinor - input.persistedMinor! : null;
  return {
    date: input.date,
    difference: differenceMinor === null ? null : money(differenceMinor, input.currency),
    diverges:
      differenceMinor !== null && Math.abs(differenceMinor) > DIVERGENCE_EPSILON_MINOR,
    isSnapshot: input.isSnapshot,
    live: money(liveMinor, input.currency),
    persisted: hasPersisted ? money(input.persistedMinor!, input.currency) : null,
  };
}

function fidelityFrom(
  reconciliation: readonly AgentViewCalculationTracePoint[],
): AgentViewCalculationTraceFidelity {
  const checked = reconciliation.filter((point) => point.persisted !== null);
  const divergences = checked.filter((point) => point.diverges);
  return {
    checkedPoints: checked.length,
    divergences,
    faithful: divergences.length === 0,
  };
}

/**
 * Build the amortization cuadro for an amortizable liability, tracing the plan
 * that governs `asOf` — the most recent balance re-baseline active by then, or the
 * original plan (ADR 0056). Events are filtered to those on or after the effective
 * plan's start, mirroring `debtBalanceAtDate`. A liability configured as
 * amortizable but with no plan is a documented 422 (no cuadro to show).
 */
async function buildSchedule(
  store: AgentViewReadStore,
  internalHoldingId: string,
  currency: string,
  asOf: string,
): Promise<AgentViewAmortizationSchedule> {
  const planRecord = await store.readAmortizationPlan(internalHoldingId);
  const rebaselineRecords = await store.readBalanceRebaselines(internalHoldingId);

  const basePlan: AmortizationPlanInput | undefined = planRecord
    ? {
        annualInterestRate: planRecord.annualInterestRate,
        disbursementDate: planRecord.disbursementDate,
        firstPaymentDate: planRecord.firstPaymentDate,
        initialCapitalMinor: planRecord.initialCapitalMinor,
        termMonths: planRecord.termMonths,
      }
    : undefined;
  const rebaselines: BalanceRebaselineInput[] = rebaselineRecords.map((r) => ({
    annualInterestRate: r.annualInterestRate,
    baselineDate: r.baselineDate,
    endDate: r.endDate,
    nextPaymentDate: r.nextPaymentDate,
    outstandingBalanceMinor: r.outstandingBalanceMinor,
    ...(r.startsAtBaseline ? { startsAtBaseline: r.startsAtBaseline } : {}),
  }));

  const effective = effectiveAmortizationPlan({
    balanceRebaselines: rebaselines,
    ...(basePlan ? { plan: basePlan } : {}),
    targetDate: asOf,
  });
  if (effective === null || "startsAfterTarget" in effective) {
    throw new AgentViewHttpError({
      code: "unprocessable_entity",
      message:
        "This amortizable liability has no amortization plan effective today, so it has no calculation trace.",
      status: 422,
    });
  }

  const allRevisions: InterestRateRevision[] = planRecord
    ? (await store.readInterestRateRevisions(planRecord.id)).map((revision) => ({
        newAnnualInterestRate: revision.newAnnualInterestRate,
        revisionDate: revision.revisionDate,
      }))
    : [];
  const allRepayments: EarlyRepayment[] = planRecord
    ? (await store.readEarlyRepayments(planRecord.id)).map((repayment) => ({
        amountMinor: repayment.amountMinor,
        mode: repayment.mode,
        repaymentDate: repayment.repaymentDate,
      }))
    : [];
  const revisions = allRevisions.filter(
    (revision) => revision.revisionDate >= effective.effectiveFrom,
  );
  const earlyRepayments = allRepayments.filter(
    (repayment) => repayment.repaymentDate >= effective.effectiveFrom,
  );

  const trace = amortizationScheduleTrace({
    earlyRepayments,
    plan: effective.plan,
    revisions,
    targetDate: asOf,
  });

  return {
    disbursementDate: effective.plan.disbursementDate,
    effectiveFrom: effective.effectiveFrom,
    firstPaymentDate: effective.plan.firstPaymentDate,
    frontiers: trace.periods.map((period) => ({
      annualInterestRate: period.annualInterestRate,
      closingBalance: money(period.closingBalanceMinor, currency),
      date: period.date,
      events: period.events.map((event) => toScheduleEvent(event, currency)),
      index: period.index,
      interest: money(period.interestMinor, currency),
      openingBalance: money(period.openingBalanceMinor, currency),
      payment: money(period.paymentMinor, currency),
      principal: money(period.principalMinor, currency),
    })),
    initialCapital: money(effective.plan.initialCapitalMinor, currency),
    termMonths: effective.plan.termMonths,
  };
}

function toScheduleEvent(
  event: {
    kind: "rate_revision" | "early_repayment";
    date: string;
    annualInterestRate?: string;
    amountMinor?: number;
    mode?: "reduce-payment" | "reduce-term";
  },
  currency: string,
): AgentViewAmortizationScheduleEvent {
  return {
    date: event.date,
    kind: event.kind,
    ...(event.annualInterestRate === undefined
      ? {}
      : { annualInterestRate: event.annualInterestRate }),
    ...(event.amountMinor === undefined
      ? {}
      : { amount: money(event.amountMinor, currency) }),
    ...(event.mode === undefined ? {} : { mode: event.mode }),
  };
}

/** Assemble the declared balance anchors of a revolving/informal liability. */
async function buildBalanceAnchors(
  store: AgentViewReadStore,
  internalHoldingId: string,
  debtModel: Exclude<AgentViewCalculationTraceModel, "amortizable">,
  currency: string,
): Promise<AgentViewBalanceAnchorFacts> {
  const anchors = await store.readBalanceAnchors(internalHoldingId);
  return {
    anchors: anchors.map((anchor) => ({
      balance: money(anchor.balanceMinor, currency),
      date: anchor.anchorDate,
      id: derivePublicId("ban", anchor.id),
      object: "balance_anchor" as const,
    })),
    interpolation: interpolationFor(debtModel),
  };
}

/** Revolving interpolates linearly between anchors; informal steps (debt-balance.ts). */
function interpolationFor(
  debtModel: Exclude<AgentViewCalculationTraceModel, "amortizable">,
): AgentViewBalanceInterpolation {
  return debtModel === "revolving" ? "linear" : "step";
}

/**
 * The modeling-tolerance verdict: the band for the current balance, plus (when a
 * declared figure was supplied) the residual of that figure against the engine's
 * live balance on the declared date and whether it falls within the band.
 */
async function buildTolerance(input: {
  currentBalanceMinor: number;
  asOf: string;
  currency: string;
  declaredBalanceMinor?: number;
  declaredDate?: string;
  liveAt: (date: string) => Promise<number | null>;
}): Promise<AgentViewCalculationTraceTolerance> {
  const base: AgentViewCalculationTraceTolerance = {
    band: money(toleranceBandMinor(input.currentBalanceMinor), input.currency),
    referenceBalance: money(input.currentBalanceMinor, input.currency),
    referenceDate: input.asOf,
  };

  if (input.declaredBalanceMinor === undefined) {
    return base;
  }

  const declaredDate = input.declaredDate ?? input.asOf;
  // `liveAt` returns a genuine balance (0 = paid off) for an owned holding, so the
  // residual is always compared against the declared date's own live balance.
  const liveMinor =
    declaredDate === input.asOf
      ? input.currentBalanceMinor
      : ((await input.liveAt(declaredDate)) ?? 0);
  const residualMinor = input.declaredBalanceMinor - liveMinor;
  const bandMinor = toleranceBandMinor(liveMinor);

  return {
    ...base,
    declared: {
      balance: money(input.declaredBalanceMinor, input.currency),
      date: declaredDate,
      residual: money(residualMinor, input.currency),
      withinTolerance: Math.abs(residualMinor) <= bandMinor,
    },
  };
}

/** `max(1 €, round(0.05 % of |balance|))`, in integer minor units. */
export function toleranceBandMinor(balanceMinor: number): number {
  return Math.max(
    MODELING_TOLERANCE_FLOOR_MINOR,
    Math.round(Math.abs(balanceMinor) * MODELING_TOLERANCE_RATE),
  );
}

function householdScope(workspace: Workspace) {
  const scope = listScopeOptions(workspace).find(
    (option) => option.id === HOUSEHOLD_SCOPE_ID,
  );
  if (!scope) {
    throw new AgentViewHttpError({
      code: "internal_error",
      message: "Agent view household scope is not resolvable.",
      status: 500,
    });
  }
  return scope;
}

function money(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

function unknownHolding(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown holding.",
    status: 404,
  });
}
