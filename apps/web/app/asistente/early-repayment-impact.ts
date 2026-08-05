/**
 * The real impact of a proposed early repayment (#1245, PRD #1241), computed by
 * the domain and never by the model. `propose_early_repayment` is a façade over
 * the `EarlyRepayment` the engine already models: every figure here comes from
 * `amortizableBalanceAtDate` / `amortizationScheduleTrace` / `debtBalanceAtDate`,
 * so the preview shows what worthline will actually do — not what the bank's
 * screen promised.
 *
 * Two honesty duties this module owns, both of them the review focus of the slice:
 *
 *  1. **The month boundary.** The balance drops on the repayment date itself
 *     (#1291), but the CUOTA is recomputed for the cycle the date falls in — the
 *     largest month start ≤ its date (#182), the same granularity as a rate
 *     revision. A lump paid on the 20th therefore lowers the balance that day while
 *     the recalculated cuota is the one of the 15th's cycle. When the two dates
 *     differ the preview says so.
 *  2. **Reconciliation against what was observed.** If the cuota read off the
 *     capture is not the cuota the plan derives, the plan's parameters and reality
 *     disagree. The proposal WARNS and still lets the user confirm — it never
 *     quietly adopts the bank's number nor hides its own.
 *  3. **A ceiling on the amount (#1266).** The parser catches the euros-for-cents
 *     mistake downwards (`91.32` is rejected, never rounded) but only the live
 *     balance can catch it upwards: `913200` for 91,32 € is a well-formed integer,
 *     and the engine clamps the principal at 0, so it would preview — and persist —
 *     a 9.132 € lump against a 4.200 € loan. A real cancellation is worth principal
 *     plus the month's accrual, so anything past that is a unit slip, not a payoff.
 *
 * Pure: no store, no clock. `today` is a parameter.
 */

import {
  type AmortizationPlanInput,
  amortizableBalanceAtDate,
  amortizationScheduleTrace,
  assertEventWithinTerm,
  type BalanceRebaselineInput,
  debtBalanceAtDate,
  type EarlyRepayment,
  effectiveAmortizationPlan,
  eventBoundaryDate,
  type InterestRateRevision,
  type ValuationCadence,
} from "@worthline/domain";

import { formatIsoDayEs } from "./iso-day-es";

export interface EarlyRepaymentImpactInput {
  /** The declared amortization plan, when the debt has one. */
  plan: AmortizationPlanInput;
  revisions: readonly InterestRateRevision[];
  /** Early repayments already registered against the plan. */
  existing: readonly EarlyRepayment[];
  /** Current-state re-baselines (ADR 0056) that may govern the target date. */
  balanceRebaselines: readonly BalanceRebaselineInput[];
  cadence: ValuationCadence | null;
  /** The liability's stored balance, the fallback the dispatcher uses. */
  currentBalanceMinor: number;
  today: string;
  proposed: EarlyRepayment;
  /** The cuota read off the capture, integer minor units, when it was visible. */
  observedMonthlyPaymentMinor?: number;
  /** ISO 4217 code used to render the notes; defaults to EUR. */
  currency?: string;
}

export interface EarlyRepaymentReconciliation {
  observedMonthlyPaymentMinor: number;
  planMonthlyPaymentMinor: number;
  matches: boolean;
}

export interface EarlyRepaymentImpact {
  ok: true;
  /** The cuota cycle the domain recomputes the payment for (the lump's boundary). */
  boundaryDate: string;
  /**
   * True when that cuota is dated on the repayment day itself, i.e. the balance step
   * and the recomputed cuota share one date and there are no two dates to explain.
   */
  boundaryIsRepaymentDate: boolean;
  /** Live balance ON the repayment date, before the lump (#1291). */
  balanceBeforeMinor: number;
  /** Live balance ON the repayment date, with the lump applied. */
  balanceAfterMinor: number;
  monthlyPaymentBeforeMinor: number;
  /** 0 when the lump closes the loan. */
  monthlyPaymentAfterMinor: number;
  endDateBefore: string;
  endDateAfter: string;
  balanceTodayBeforeMinor: number;
  balanceTodayAfterMinor: number;
  fullyRepaid: boolean;
  reconciliation: EarlyRepaymentReconciliation | null;
  /** User-facing es-ES warnings; never blocking, never silent. */
  notes: string[];
}

export type EarlyRepaymentImpactResult =
  | EarlyRepaymentImpact
  | { ok: false; error: string };

/**
 * Cents-precise es-ES euros. `formatMoneyMinor` drops the cents (it renders
 * whole-euro totals) and a repayment is exact to the cent — 91,32 € shown as
 * «91 €» would misreport the very figure the user is confirming.
 */
function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("es-ES", {
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

/**
 * YYYY-MM-DD → DD/MM/YYYY. The slicing itself lives in {@link formatIsoDayEs}, a
 * leaf module: the client-side cards need the same format and must not import this
 * one (it pulls the amortization engine).
 */
export const formatDayEs = formatIsoDayEs;

export function projectEarlyRepaymentImpact(
  input: EarlyRepaymentImpactInput,
): EarlyRepaymentImpactResult {
  const currency = input.currency ?? "EUR";
  const { proposed } = input;

  // ADR 0056: a re-baseline active on the repayment date replaces the declared
  // plan from its own date, and events before it are not applied. Resolving the
  // governing schedule here is what keeps the preview from describing a curve the
  // product does not draw.
  const effective = effectiveAmortizationPlan({
    balanceRebaselines: input.balanceRebaselines,
    plan: input.plan,
    targetDate: proposed.repaymentDate,
  });
  if (effective === null) {
    return { ok: false, error: "Esta deuda no tiene plan de amortización." };
  }
  if ("startsAfterTarget" in effective) {
    const start = [...input.balanceRebaselines]
      .filter((fact) => fact.startsAtBaseline)
      .map((fact) => fact.baselineDate)
      .sort()[0];
    return {
      ok: false,
      error: `La deuda solo está modelada desde ${start}: una anticipada anterior a esa fecha no tiene curva sobre la que aplicarse.`,
    };
  }

  const schedule = effective.plan;
  if (proposed.repaymentDate < schedule.firstPaymentDate) {
    return {
      ok: false,
      error: `La primera cuota de este préstamo es del ${formatDayEs(schedule.firstPaymentDate)}: una anticipada anterior no cae en ninguna cuota. Comprueba la fecha.`,
    };
  }

  // #210: a date past the final payment boundary would be silently dropped by the
  // schedule build. Both plans are checked — the effective one because it is what
  // the engine reads, and the declared one because it is what the store validates
  // on write — so the proposal never previews a repayment the confirm would reject.
  for (const candidate of new Set([schedule, input.plan])) {
    try {
      assertEventWithinTerm(candidate, proposed.repaymentDate, "Repayment date");
    } catch {
      return {
        ok: false,
        error: `Esa fecha cae después de la última cuota del préstamo, así que quedaría fuera del plazo. Comprueba la fecha de la anticipada.`,
      };
    }
  }

  const relevant = <T extends { revisionDate: string } | { repaymentDate: string }>(
    events: readonly T[],
  ): T[] =>
    events.filter((event) =>
      "revisionDate" in event
        ? event.revisionDate >= effective.effectiveFrom
        : event.repaymentDate >= effective.effectiveFrom,
    );

  const revisions = relevant(input.revisions);
  const existing = relevant(input.existing);
  const withProposed = [...existing, proposed];
  const boundaryDate = eventBoundaryDate(schedule, proposed.repaymentDate);

  const balanceAt = (repayments: readonly EarlyRepayment[], targetDate: string): number =>
    amortizableBalanceAtDate({
      cadence: "step",
      earlyRepayments: repayments,
      plan: schedule,
      revisions,
      targetDate,
    });

  // The pair is read ON the repayment date: that is where the curve steps down
  // (#1291) and the balance the amount is actually paid against — the figure the
  // ceiling below must judge, and the one the preview shows.
  const balanceBeforeMinor = balanceAt(existing, proposed.repaymentDate);
  if (balanceBeforeMinor === 0) {
    return {
      ok: false,
      error: `En ${formatDayEs(proposed.repaymentDate)} el préstamo ya está a cero, así que no hay saldo que amortizar.`,
    };
  }
  const traceBefore = amortizationScheduleTrace({
    earlyRepayments: existing,
    plan: schedule,
    revisions,
    targetDate: boundaryDate,
  });

  // The cuota in force AFTER the boundary is the payment of the first period that
  // opens on it — the period dated after the boundary. `reduce-term` keeps it,
  // `reduce-payment` recomputes it over the remaining term.
  const paymentAfterBoundary = (
    periods: (typeof traceBefore)["periods"],
  ): number | null =>
    periods.find((period) => period.date > boundaryDate)?.paymentMinor ?? null;
  const endDateOf = (periods: (typeof traceBefore)["periods"]): string =>
    periods[periods.length - 1]?.date ?? boundaryDate;

  const monthlyPaymentBeforeMinor = paymentAfterBoundary(traceBefore.periods) ?? 0;

  // #1266: the ceiling. One cuota over the live balance is the room a genuine
  // cancellation needs (accrued interest + a cancellation fee); past that the
  // engine's clamp at 0 would turn a unit slip into a plausible-looking payoff.
  // On the loan's last boundary there is no next cuota, so the allowance falls
  // back to the one being paid — never to zero, which would reject a real payoff.
  const allowanceMinor =
    monthlyPaymentBeforeMinor ||
    (traceBefore.periods[traceBefore.periods.length - 1]?.paymentMinor ?? 0);
  if (proposed.amountMinor > balanceBeforeMinor + allowanceMinor) {
    return {
      ok: false,
      error: `El importe (${money(proposed.amountMinor, currency)}) supera el saldo vivo del préstamo en ${formatDayEs(proposed.repaymentDate)} (${money(balanceBeforeMinor, currency)}). Una cancelación total vale el principal más el devengo del mes, no diez veces el saldo: esto parece un error de unidad (euros escritos como céntimos). Comprueba la cifra antes de registrarla.`,
    };
  }

  const balanceAfterMinor = balanceAt(withProposed, proposed.repaymentDate);
  const fullyRepaid = balanceAfterMinor === 0;

  const traceAfter = amortizationScheduleTrace({
    earlyRepayments: withProposed,
    plan: schedule,
    revisions,
    targetDate: boundaryDate,
  });

  const monthlyPaymentAfterMinor = fullyRepaid
    ? 0
    : (paymentAfterBoundary(traceAfter.periods) ?? 0);
  const endDateBefore = endDateOf(traceBefore.periods);
  const endDateAfter = fullyRepaid ? boundaryDate : endDateOf(traceAfter.periods);

  // Today's figure goes through the dispatcher, with re-baselines and cadence, so
  // it is the number the product itself would show after confirming.
  const todayBalance = (repayments: readonly EarlyRepayment[]): number =>
    debtBalanceAtDate({
      balanceRebaselines: input.balanceRebaselines,
      cadence: input.cadence,
      currentBalanceMinor: input.currentBalanceMinor,
      debtModel: "amortizable",
      earlyRepayments: repayments,
      plan: input.plan,
      revisions: input.revisions,
      targetDate: input.today,
    });
  const balanceTodayBeforeMinor = todayBalance(input.existing);
  const balanceTodayAfterMinor = todayBalance([...input.existing, proposed]);

  const reconciliation =
    input.observedMonthlyPaymentMinor === undefined
      ? null
      : {
          matches: input.observedMonthlyPaymentMinor === monthlyPaymentAfterMinor,
          observedMonthlyPaymentMinor: input.observedMonthlyPaymentMinor,
          planMonthlyPaymentMinor: monthlyPaymentAfterMinor,
        };

  const notes: string[] = [];
  if (boundaryDate !== proposed.repaymentDate) {
    notes.push(
      `El saldo baja el mismo ${formatDayEs(proposed.repaymentDate)}, pero la anticipada cae dentro de la cuota del ${formatDayEs(boundaryDate)}: es esa cuota la que se recalcula con el saldo ya reducido.`,
    );
  }
  if (fullyRepaid) {
    notes.push(
      `El importe (${money(proposed.amountMinor, currency)}) cubre todo el saldo vivo de esa fecha (${money(balanceBeforeMinor, currency)}): la anticipada cancela el préstamo por completo y la curva queda a cero.`,
    );
  }
  const sameBoundary = existing.filter(
    (repayment) =>
      repayment.repaymentDate !== proposed.repaymentDate &&
      eventBoundaryDate(schedule, repayment.repaymentDate) === boundaryDate,
  );
  for (const repayment of sameBoundary) {
    notes.push(
      `Ya hay una anticipada del ${formatDayEs(repayment.repaymentDate)} (${money(repayment.amountMinor, currency)}) en esa misma cuota: cada una baja el saldo en su propia fecha, y la cuota se recalcula con las dos ya restadas.`,
    );
  }
  if (reconciliation && !reconciliation.matches && monthlyPaymentAfterMinor > 0) {
    notes.push(
      `La cuota que se lee en la captura (${money(reconciliation.observedMonthlyPaymentMinor, currency)}) no coincide con la que calcula el plan tras la anticipada (${money(monthlyPaymentAfterMinor, currency)}). Registro el hecho igualmente, pero revisa las condiciones del préstamo: algo no cuadra.`,
    );
  }
  if (
    proposed.repaymentDate <= input.today &&
    balanceTodayAfterMinor === balanceTodayBeforeMinor
  ) {
    // ADR 0048: the cause is only named when it exists. A frozen today's figure
    // has more than one explanation — a re-baseline that governs from a later
    // date, or a loan already paid off — and asserting the first one when the
    // workspace has no re-baseline invents a fact (#1266).
    const governing = [...input.balanceRebaselines]
      .filter(
        (fact) =>
          fact.baselineDate > proposed.repaymentDate && fact.baselineDate <= input.today,
      )
      .sort((a, b) => a.baselineDate.localeCompare(b.baselineDate))[0];
    notes.push(
      governing
        ? `Esta anticipada no cambia el saldo de hoy: hay una recalibración posterior (${formatDayEs(governing.baselineDate)}) que manda sobre la curva a partir de su fecha, así que solo corrige el tramo anterior.`
        : balanceTodayAfterMinor === 0
          ? `Esta anticipada no cambia el saldo de hoy: el préstamo ya estaba liquidado antes de hoy, así que esto solo corrige el histórico.`
          : `Esta anticipada no cambia el saldo de hoy, así que solo corrige el tramo anterior de la curva.`,
    );
  }

  return {
    boundaryIsRepaymentDate: boundaryDate === proposed.repaymentDate,
    balanceAfterMinor,
    balanceBeforeMinor,
    balanceTodayAfterMinor,
    balanceTodayBeforeMinor,
    boundaryDate,
    endDateAfter,
    endDateBefore,
    fullyRepaid,
    monthlyPaymentAfterMinor,
    monthlyPaymentBeforeMinor,
    notes,
    ok: true,
    reconciliation,
  };
}
