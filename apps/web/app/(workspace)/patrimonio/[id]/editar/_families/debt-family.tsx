/**
 * The liability ficha (PRD #109): the debt-model editor and the two figures that
 * frame the repair beside it.
 *
 * The model selector fans out INSIDE `DebtModelSection`; what this loader owns is
 * which rows that fan-out needs, and the fact that they hang off each other —
 * plan and re-baselines off the liability, revisions and early repayments off the
 * plan (#446). Both waves are needed even when one comes back empty: a
 * re-baseline alone can govern the curve with no plan row (ADR 0056, #678).
 */

import { DebtModelSection } from "@web/patrimonio/[id]/editar/_surfaces/debt-model-section";
import type { DebtBalanceAtDateInput } from "@worthline/domain";
import {
  debtAccrualAtDate,
  debtBalanceAtDate,
  storedBalanceGovernsDebtFigure,
} from "@worthline/domain";
import type { DebtFamilyContext, HoldingSurface } from "./family-contract";
import { holdingSurface } from "./family-contract";

export async function loadDebtSurface(ctx: DebtFamilyContext): Promise<HoldingSurface> {
  const { currentUrl, formError, id, liability, privacyMode, store, today } = ctx;

  const debtModel = await store.liabilities.readDebtModel(id);

  const [amortizationPlan, balanceRebaselines] =
    debtModel === "amortizable"
      ? await Promise.all([
          store.liabilities.readAmortizationPlan(id),
          store.liabilities.readBalanceRebaselines(id),
        ])
      : [null, []];
  const [rateRevisions, earlyRepayments] = amortizationPlan
    ? await Promise.all([
        store.liabilities.readInterestRateRevisions(amortizationPlan.id),
        store.liabilities.readEarlyRepayments(amortizationPlan.id),
      ])
    : [[], []];
  const balanceAnchors =
    debtModel === "revolving" || debtModel === "informal"
      ? await store.liabilities.readBalanceAnchors(id)
      : [];
  // Valuation cadence (ADR 0031, #393); null reads as the default `step`.
  const valuationCadence = await store.liabilities.readValuationCadence(id);

  // The curve inputs of an amortizable debt, assembled ONCE from the rows read
  // above. Both figures below come out of this same object, so the balance and
  // its accrual provably describe one curve — and the second figure costs no
  // extra I/O, where `store.liabilities.debtBalanceAtDate` would re-read every
  // row this loader already holds (#1292).
  const debtCurveInput =
    debtModel === "amortizable" && (amortizationPlan || balanceRebaselines.length > 0)
      ? ({
          balanceRebaselines,
          currentBalanceMinor: liability.currentBalance.amountMinor,
          debtModel,
          earlyRepayments: earlyRepayments.map((repayment) => ({
            amountMinor: repayment.amountMinor,
            mode: repayment.mode,
            repaymentDate: repayment.repaymentDate,
          })),
          revisions: rateRevisions.map((revision) => ({
            newAnnualInterestRate: revision.newAnnualInterestRate,
            revisionDate: revision.revisionDate,
          })),
          targetDate: today,
          ...(amortizationPlan
            ? {
                plan: {
                  annualInterestRate: amortizationPlan.annualInterestRate,
                  disbursementDate: amortizationPlan.disbursementDate,
                  firstPaymentDate: amortizationPlan.firstPaymentDate,
                  initialCapitalMinor: amortizationPlan.initialCapitalMinor,
                  termMonths: amortizationPlan.termMonths,
                },
              }
            : {}),
          ...(valuationCadence != null ? { cadence: valuationCadence } : {}),
        } satisfies DebtBalanceAtDateInput)
      : null;

  return holdingSurface("debt", {
    body: (
      <DebtModelSection
        amortizationPlan={amortizationPlan}
        balanceAnchors={balanceAnchors}
        // The current MODELLED balance, shown beside "Recalibrar con saldo real"
        // (ADR 0056, PRD #670 S3, #678) so the drift against the bank's real
        // figure is visible at the moment of repair — meaningful as soon as a
        // CURVE exists, plan row or re-baseline alike (#1290) — and what has
        // accrued on it since the last cuota, so the surface can name WHICH
        // magnitude the user is comparing with the bank's screen (#1292).
        currentDebtAccrual={debtCurveInput ? debtAccrualAtDate(debtCurveInput) : null}
        currentModelledBalanceMinor={
          debtCurveInput ? debtBalanceAtDate(debtCurveInput) : null
        }
        currentUrl={currentUrl}
        debtModel={debtModel}
        earlyRepayments={earlyRepayments}
        formError={formError}
        liabilityId={id}
        privacyMode={privacyMode}
        rateRevisions={rateRevisions}
        today={today}
        valuationCadence={valuationCadence}
      />
    ),
    basics: {
      // Which door repairs this debt's balance (#1290): the raw
      // `current_balance_minor` form only when the engine still reads that field.
      showRawBalanceForm: storedBalanceGovernsDebtFigure({
        debtModel,
        hasAmortizationPlan: amortizationPlan !== null,
        hasBalanceAnchors: balanceAnchors.length > 0,
        hasBalanceRebaselines: balanceRebaselines.length > 0,
      }),
    },
  });
}
