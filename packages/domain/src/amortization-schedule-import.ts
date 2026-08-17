import Big from "big.js";

import {
  type AmortizationPlanInput,
  addMonths,
  type BalanceRebaselineInput,
  type EarlyRepayment,
  type EarlyRepaymentMode,
  eventBoundaryDate,
  type InterestRateRevision,
} from "./amortization";
import type {
  AmortizationScheduleReading,
  ScheduleDeclaredBalance,
} from "./amortization-schedule-adapter";
import { balancesAgree } from "./balance-tolerance";
import { debtBalanceAtDate } from "./debt-balance";
import type { DecimalString } from "./decimal";
import type { ValuationCadence } from "./valuation-cadence";

/**
 * What loading a **cuadro de amortización** onto an existing plan would do (#1406),
 * decided before anything is written.
 *
 * The constraint the issue's decision hands down: **the reader does not rewrite the
 * plan**. It writes `interest_rate_revisions` and `early_repayments` over the plan
 * that already exists, and the preview verifies them against the balances the
 * document itself declares before saving. That verification is the best idea in the
 * issue and the reason this import is safe at all: a schedule is self-verifying —
 * if our curve does not reproduce the balances the document prints, the reading is
 * wrong and it must be said BEFORE writing, not discovered afterwards.
 *
 * The curve it verifies with is `debtBalanceAtDate` — the very engine that will
 * draw the debt on screen, rebaselines and all. Two consequences worth naming:
 *
 * - **A re-baseline still wins, and no re-baseline is retired.** ADR 0056's
 *   precedence already answers the issue's open question: for a date on or after a
 *   re-baseline, the re-baseline governs and the revisions before it are simply not
 *   read. So a reconstruction fills exactly the stretch the re-baselines do not
 *   cover — the twenty years of Jorge's mortgage that were fiction — and touches
 *   nothing they do. Each checkpoint reports {@link ScheduleCheckpoint.governedBy}
 *   so the preview can say which stretch is whose.
 * - **The verification measures the figure the user will actually see**, not an
 *   idealized plan curve. That is the same rule the reconciliation of #1422 learned:
 *   if you compare two figures, they come out of the SAME engine.
 *
 * Pure: no clock, no I/O. `today` is a parameter where it is needed at all.
 */

/** Why a read event is or is not going to be written. */
export type ScheduleEventStatus =
  /** Will be created. */
  | "new"
  /** The plan already carries an event on that date; the document adds nothing. */
  | "duplicate"
  /**
   * Its date falls past the loan's final payment boundary, where the engine would
   * never read it (`assertEventWithinTerm`, #210). Refused rather than dropped.
   */
  | "outside-term";

export interface PlannedRevision extends InterestRateRevision {
  status: ScheduleEventStatus;
  /** The rate already stored for that date, when a duplicate disagrees with it. */
  existingAnnualInterestRate?: DecimalString;
}

export interface PlannedEarlyRepayment extends EarlyRepayment {
  status: ScheduleEventStatus;
}

/** One declared balance measured against the curve the import would produce. */
export interface ScheduleCheckpoint {
  dateKey: string;
  /** What the document prints for that date. */
  declaredMinor: number;
  /** What worthline's curve would say there, with the import applied. */
  curveMinor: number;
  /** `curveMinor - declaredMinor`, signed. */
  deltaMinor: number;
  /** Within the shared tolerance (ADR 0070). */
  agrees: boolean;
  /**
   * Which fact governs the curve on that date: the amortization plan the document
   * is reconstructing, or a balance re-baseline that already covers it (ADR 0056).
   */
  governedBy: "plan" | "rebaseline";
}

export interface AmortizationScheduleImportPlan {
  revisions: PlannedRevision[];
  earlyRepayments: PlannedEarlyRepayment[];
  checkpoints: ScheduleCheckpoint[];
  /**
   * The document's rates were re-read one hundredfold smaller because that is the
   * reading its own balances reproduce (see {@link AmortizationScheduleReading.rateScaleAmbiguous}).
   */
  rateScaleAdjusted: boolean;
  summary: ScheduleImportSummary;
  warnings: string[];
}

export interface ScheduleImportSummary {
  newRevisionCount: number;
  duplicateRevisionCount: number;
  newEarlyRepaymentCount: number;
  duplicateEarlyRepaymentCount: number;
  outsideTermCount: number;
  checkedCount: number;
  agreeingCount: number;
  /** The checkpoint the curve misses by most, or null when every one agrees. */
  worstDrift: { dateKey: string; deltaMinor: number } | null;
  /** The earliest date any written event anchors to — the ripple floor. */
  rippleFromDateKey: string | null;
}

export interface AmortizationScheduleImportContext {
  plan: AmortizationPlanInput;
  existingRevisions: readonly InterestRateRevision[];
  existingEarlyRepayments: readonly EarlyRepayment[];
  balanceRebaselines: readonly BalanceRebaselineInput[];
  currentBalanceMinor: number;
  cadence?: ValuationCadence | null;
  /**
   * How a lump read off a document reshapes the schedule. A cuadro shows the lump
   * and its aftermath but never says which of the two the borrower chose, so the
   * caller decides and the preview names it. `reduce-payment` (keep the end date,
   * lower the cuota) is the bank default.
   */
  earlyRepaymentMode?: EarlyRepaymentMode;
}

/** The final payment boundary is `termMonths` cuotas after the first payment. */
function isOutsideTerm(plan: AmortizationPlanInput, dateKey: string): boolean {
  // `eventBoundaryDate` clamps nothing, so an event past the last boundary maps to
  // a boundary that does not exist. Comparing against the final boundary's date is
  // the same test `assertEventWithinTerm` makes, without the throw.
  return eventBoundaryDate(plan, dateKey) >= finalBoundaryDate(plan);
}

/** Boundary `m` is `firstPayment + (m − 1)` months, so the last one is `term − 1`. */
function finalBoundaryDate(plan: AmortizationPlanInput): string {
  return addMonths(plan.firstPaymentDate, plan.termMonths - 1);
}

function scaleRate(rate: DecimalString, adjust: boolean): DecimalString {
  return adjust ? new Big(rate).div(100).toString() : rate;
}

function planRevisions(
  reading: AmortizationScheduleReading,
  context: AmortizationScheduleImportContext,
  adjustScale: boolean,
): PlannedRevision[] {
  const existingByDate = new Map(
    context.existingRevisions.map((revision) => [revision.revisionDate, revision]),
  );

  return reading.revisions.map((revision) => {
    const annualInterestRate = scaleRate(revision.annualInterestRate, adjustScale);
    const existing = existingByDate.get(revision.revisionDate);
    if (existing) {
      const differs = !new Big(existing.newAnnualInterestRate).eq(annualInterestRate);
      return {
        newAnnualInterestRate: annualInterestRate,
        revisionDate: revision.revisionDate,
        status: "duplicate" as const,
        ...(differs
          ? { existingAnnualInterestRate: existing.newAnnualInterestRate }
          : {}),
      };
    }
    return {
      newAnnualInterestRate: annualInterestRate,
      revisionDate: revision.revisionDate,
      status: isOutsideTerm(context.plan, revision.revisionDate)
        ? ("outside-term" as const)
        : ("new" as const),
    };
  });
}

function planEarlyRepayments(
  reading: AmortizationScheduleReading,
  context: AmortizationScheduleImportContext,
): PlannedEarlyRepayment[] {
  const mode = context.earlyRepaymentMode ?? "reduce-payment";
  const existingDates = new Set(
    context.existingEarlyRepayments.map((repayment) => repayment.repaymentDate),
  );

  return reading.earlyRepayments.map((repayment) => ({
    amountMinor: repayment.amountMinor,
    mode,
    repaymentDate: repayment.repaymentDate,
    status: existingDates.has(repayment.repaymentDate)
      ? ("duplicate" as const)
      : isOutsideTerm(context.plan, repayment.repaymentDate)
        ? ("outside-term" as const)
        : ("new" as const),
  }));
}

/** Every event the curve would carry after the import: the stored ones plus the new. */
function mergedEvents(
  context: AmortizationScheduleImportContext,
  revisions: readonly PlannedRevision[],
  earlyRepayments: readonly PlannedEarlyRepayment[],
): { revisions: InterestRateRevision[]; earlyRepayments: EarlyRepayment[] } {
  return {
    earlyRepayments: [
      ...context.existingEarlyRepayments,
      ...earlyRepayments
        .filter((repayment) => repayment.status === "new")
        .map(({ amountMinor, mode, repaymentDate }) => ({
          amountMinor,
          mode,
          repaymentDate,
        })),
    ],
    revisions: [
      ...context.existingRevisions,
      ...revisions
        .filter((revision) => revision.status === "new")
        .map(({ newAnnualInterestRate, revisionDate }) => ({
          newAnnualInterestRate,
          revisionDate,
        })),
    ],
  };
}

function checkpointsFor(
  declaredBalances: readonly ScheduleDeclaredBalance[],
  context: AmortizationScheduleImportContext,
  events: { revisions: InterestRateRevision[]; earlyRepayments: EarlyRepayment[] },
): ScheduleCheckpoint[] {
  return declaredBalances.map((declared) => {
    const curveMinor = debtBalanceAtDate({
      balanceRebaselines: context.balanceRebaselines,
      cadence: context.cadence ?? null,
      currentBalanceMinor: context.currentBalanceMinor,
      debtModel: "amortizable",
      earlyRepayments: events.earlyRepayments,
      plan: context.plan,
      revisions: events.revisions,
      targetDate: declared.dateKey,
    });
    // ADR 0056's precedence, read straight: any re-baseline dated on or before the
    // checkpoint governs it, and the document's revisions before it are not read
    // there at all. This is the answer to the issue's open question — the
    // re-baseline wins and none is retired, because the reconstruction only ever
    // fills the stretch they do not cover.
    const governedBy = context.balanceRebaselines.some(
      (rebaseline) => rebaseline.baselineDate <= declared.dateKey,
    )
      ? ("rebaseline" as const)
      : ("plan" as const);

    return {
      agrees: balancesAgree(declared.balanceMinor, curveMinor),
      curveMinor,
      dateKey: declared.dateKey,
      declaredMinor: declared.balanceMinor,
      deltaMinor: curveMinor - declared.balanceMinor,
      governedBy,
    };
  });
}

function summarize(
  plan: AmortizationPlanInput,
  revisions: readonly PlannedRevision[],
  earlyRepayments: readonly PlannedEarlyRepayment[],
  checkpoints: readonly ScheduleCheckpoint[],
): ScheduleImportSummary {
  const newDates = [
    ...revisions.filter((r) => r.status === "new").map((r) => r.revisionDate),
    ...earlyRepayments.filter((r) => r.status === "new").map((r) => r.repaymentDate),
  ].sort();

  const worst = checkpoints.reduce<ScheduleCheckpoint | null>(
    (accumulated, checkpoint) =>
      !checkpoint.agrees &&
      (accumulated === null ||
        Math.abs(checkpoint.deltaMinor) > Math.abs(accumulated.deltaMinor))
        ? checkpoint
        : accumulated,
    null,
  );

  return {
    agreeingCount: checkpoints.filter((checkpoint) => checkpoint.agrees).length,
    checkedCount: checkpoints.length,
    duplicateEarlyRepaymentCount: earlyRepayments.filter((r) => r.status === "duplicate")
      .length,
    duplicateRevisionCount: revisions.filter((r) => r.status === "duplicate").length,
    newEarlyRepaymentCount: earlyRepayments.filter((r) => r.status === "new").length,
    newRevisionCount: revisions.filter((r) => r.status === "new").length,
    outsideTermCount: [...revisions, ...earlyRepayments].filter(
      (event) => event.status === "outside-term",
    ).length,
    // The ripple floor is the event's cuota BOUNDARY, never its raw date (#1042):
    // both event kinds reshape the whole cycle they land in.
    rippleFromDateKey: newDates[0] ? eventBoundaryDate(plan, newDates[0]) : null,
    worstDrift:
      worst === null ? null : { dateKey: worst.dateKey, deltaMinor: worst.deltaMinor },
  };
}

function buildAt(
  reading: AmortizationScheduleReading,
  context: AmortizationScheduleImportContext,
  adjustScale: boolean,
): AmortizationScheduleImportPlan {
  const revisions = planRevisions(reading, context, adjustScale);
  const earlyRepayments = planEarlyRepayments(reading, context);
  const checkpoints = checkpointsFor(
    reading.declaredBalances,
    context,
    mergedEvents(context, revisions, earlyRepayments),
  );

  return {
    checkpoints,
    earlyRepayments,
    rateScaleAdjusted: adjustScale,
    revisions,
    summary: summarize(context.plan, revisions, earlyRepayments, checkpoints),
    warnings: [...reading.warnings],
  };
}

const RATE_SCALE_ADJUSTED_WARNING =
  "Los tipos del documento no llevan «%» y ninguno pasa de 1, así que podían leerse de dos maneras. Los he leído cien veces más pequeños porque es la lectura que reproduce los saldos que el propio cuadro declara.";

/**
 * What loading `reading` onto `context.plan` would create, and whether the
 * resulting curve reproduces the balances the document declares.
 *
 * When the document's rate scale is genuinely ambiguous (no «%» anywhere and every
 * rate ≤ 1), both readings are computed and the one whose curve agrees with more of
 * the document's own balances wins — the schedule settling its own reading, which is
 * only possible because it prints both the causes and their consequences.
 */
export function buildAmortizationScheduleImportPlan(
  reading: AmortizationScheduleReading,
  context: AmortizationScheduleImportContext,
): AmortizationScheduleImportPlan {
  const primary = buildAt(reading, context, false);
  if (!reading.rateScaleAmbiguous || primary.checkpoints.length === 0) return primary;

  const alternate = buildAt(reading, context, true);
  if (alternate.summary.agreeingCount <= primary.summary.agreeingCount) return primary;

  return {
    ...alternate,
    warnings: [...alternate.warnings, RATE_SCALE_ADJUSTED_WARNING],
  };
}
