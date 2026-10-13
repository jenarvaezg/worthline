/**
 * The «Plan» tab of an amortizable debt (PRD #109, #1848): the plan itself — created
 * by its current state, or from the loan's original data, or edited once it exists
 * — its deletion, and the cuotas it implies.
 *
 * With no plan the «alta por estado actual» is the primary path (ADR 0056, #677);
 * the origin-declared form (ADR 0019) stays available, demoted to a disclosure.
 * Every form here returns to this tab, where its result shows.
 */

import type { FormErrorContext } from "@web/intake";
import { formatDecimalAsPercentField } from "@web/intake-primitives";
import {
  deleteAmortizationPlanAction,
  saveAmortizationPlanAction,
  saveCurrentStateAmortizationAction,
} from "@web/patrimonio/actions";
import { CurrentStateDebtFields } from "@web/patrimonio/current-state-debt-fields";
import type { AmortizationPlanRecord } from "@worthline/db";
import type { CurrencyCode } from "@worthline/domain";
import { daysBetween, firstCuota, formatMoneyInput } from "@worthline/domain";
import { DEBT_FORM_ID } from "./debt-form-ids";
import { formatCuotaPrivacy } from "./debt-format";
import { PlanDateFields } from "./plan-date-fields";

export function DebtPlanSection({
  currency,
  currentUrl,
  formError,
  liabilityId,
  plan,
  privacyMode,
  today,
}: {
  /** The debt's currency: what its cuotas are said in. */
  currency: CurrencyCode;
  /** The «Plan» tab's URL: where every form here returns. */
  currentUrl: string;
  formError: FormErrorContext | null;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  liabilityId: string;
  plan: AmortizationPlanRecord | null;
  privacyMode: boolean;
  today: string;
}) {
  const planValues =
    formError?.formId === DEBT_FORM_ID.plan
      ? formError.values
      : plan
        ? {
            annualInterestRate: formatDecimalAsPercentField(
              Number(plan.annualInterestRate),
            ),
            disbursementDate: plan.disbursementDate,
            firstPaymentDate: plan.firstPaymentDate,
            initialCapital: formatMoneyInput(plan.initialCapitalMinor),
            termMonths: String(plan.termMonths),
          }
        : {};

  return (
    <div className="debtSurface">
      {plan ? (
        <form
          action={saveAmortizationPlanAction}
          aria-label="Plan de amortización"
          className="stackForm"
        >
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <PlanFields max={today} values={planValues} />
          <div className="formActions">
            <button type="submit">Actualizar plan</button>
          </div>
        </form>
      ) : (
        <>
          <form
            action={saveCurrentStateAmortizationAction}
            aria-label="Alta por estado actual"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <CurrentStateDebtFields
              baselineDate={today}
              idPrefix={`plan-${liabilityId}`}
              initialValues={
                formError?.formId === DEBT_FORM_ID.currentState ? formError.values : {}
              }
              submitLabel="Guardar por estado actual"
            />
          </form>

          <details
            suppressHydrationWarning
            className="anchorEdit"
            open={formError?.formId === DEBT_FORM_ID.plan}
          >
            <summary>¿Tienes los datos originales del préstamo?</summary>
            <form
              action={saveAmortizationPlanAction}
              aria-label="Plan de amortización"
              className="stackForm"
            >
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="id" type="hidden" value={liabilityId} />
              <PlanFields max={today} values={planValues} />
              <div className="formActions">
                <button type="submit">Guardar plan</button>
              </div>
            </form>
          </details>
        </>
      )}

      {plan ? (
        <form action={deleteAmortizationPlanAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={plan.id} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Eliminar plan</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      ) : null}

      {plan ? (
        <PlanCuotaSummary currency={currency} plan={plan} privacyMode={privacyMode} />
      ) : null}
    </div>
  );
}

/** Shared plan fields for the create/edit amortization-plan form. */
function PlanFields({ max, values }: { max: string; values: Record<string, string> }) {
  return (
    <>
      <label>
        Capital inicial (EUR)
        <input
          aria-label="Capital inicial en EUR"
          defaultValue={values["initialCapital"]}
          inputMode="decimal"
          min="0"
          name="initialCapital"
          placeholder="200.000"
          required
        />
      </label>
      <label>
        Tipo de interés anual (%)
        <input
          aria-label="Tipo de interés anual (%)"
          defaultValue={values["annualInterestRate"]}
          inputMode="decimal"
          min="0"
          name="annualInterestRate"
          placeholder="2,5"
          required
        />
      </label>
      <label>
        Plazo (meses)
        <input
          aria-label="Plazo en meses"
          defaultValue={values["termMonths"]}
          inputMode="numeric"
          min="1"
          name="termMonths"
          placeholder="360"
          required
          step="1"
        />
      </label>
      <PlanDateFields
        initialDisbursement={values["disbursementDate"] ?? ""}
        initialFirstPayment={values["firstPaymentDate"] ?? ""}
        max={max}
      />
    </>
  );
}

/**
 * The exact first cuota with its stub interest, derived on demand from the plan
 * (ADR 0019, #190). DISPLAY ONLY: the `firstCuota` helper never feeds the balance
 * curve, snapshots, or net worth — this enlarges the *displayed* first cuota, not
 * the modeled balance. The opening period (disbursement → first payment) is longer
 * than a month, so the first cuota carries that period's stub interest on top of
 * the ordinary French principal; subsequent cuotas are the regular cuota.
 *
 * It is the ORIGINAL plan's cuotas: the one in force after a revision is the
 * header's «Cuota vigente» (#1848), read from the same curve as the balance.
 */
function PlanCuotaSummary({
  currency,
  plan,
  privacyMode,
}: {
  currency: CurrencyCode;
  plan: AmortizationPlanRecord;
  privacyMode: boolean;
}) {
  const cuota = firstCuota({
    annualInterestRate: plan.annualInterestRate,
    disbursementDate: plan.disbursementDate,
    firstPaymentDate: plan.firstPaymentDate,
    initialCapitalMinor: plan.initialCapitalMinor,
    termMonths: plan.termMonths,
  });
  const stubDays = daysBetween(plan.disbursementDate, plan.firstPaymentDate);
  const fmt = (amountMinor: number): string =>
    formatCuotaPrivacy({ amountMinor, currency }, privacyMode);

  return (
    <section className="planCuota" aria-label="Cuotas del préstamo">
      <h4>Cuotas</h4>
      <dl className="planCuotaGrid">
        <div className="planCuotaItem">
          <dt>Primera cuota</dt>
          <dd className="planCuotaFigure">{fmt(cuota.amountMinor)}</dd>
        </div>
        <div className="planCuotaItem">
          <dt>Cuota habitual</dt>
          <dd className="planCuotaFigure">{fmt(cuota.regularCuotaMinor)}</dd>
        </div>
      </dl>
      <p className="infoNote">
        La primera cuota incluye el interés del periodo de apertura ({stubDays} días, del{" "}
        {plan.disbursementDate} al {plan.firstPaymentDate}):{" "}
        {fmt(cuota.stubInterestMinor)} de intereses más {fmt(cuota.firstPrincipalMinor)}{" "}
        de capital. No altera el saldo del histórico.
      </p>
    </section>
  );
}
