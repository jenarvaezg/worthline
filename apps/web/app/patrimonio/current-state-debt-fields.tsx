"use client";

/**
 * "Alta por estado actual" fields (ADR 0056, PRD #670 S0/S2, #677) — a client
 * island scoped to the one interaction that genuinely needs it: the live
 * honesty check ("con estos datos tu cuota sale X €/mes — ¿cuadra con tu
 * banco?") shown BEFORE saving. Everything else about the surrounding form
 * stays server-driven (ADR 0009) — this is the same scoped escape hatch
 * `PlanDateFields` takes for the two-date suggestion.
 *
 * Shared by the wizard's debt drawer and the advanced edit surface's
 * current-state create form: both post these same field names to a server
 * action that re-derives and re-validates with the identical pure module
 * (`current-state-debt.ts`) — the preview a user sees is exactly what gets
 * persisted, never a client-only approximation.
 *
 * Field order follows the S0 direction: saldo pendiente hoy → fecha de fin →
 * "Dato del banco" → el dato variable. The unmodelled past is communicated as
 * a mini-timeline, not prose under each field. The original signing date is
 * optional, secondary-placed metadata inside a `<details>` — it never competes
 * with saldo/fin/cuota and never feeds the cuota/tipo math, but the shared
 * module still validates it (ISO, not future), so a bad date surfaces here
 * live instead of on the server after the rest of the form was accepted.
 */
import { formatMoneyInput, suggestFirstPaymentDate } from "@worthline/domain";
import { useMemo, useState } from "react";

import {
  CURRENT_STATE_DEBT_FIELD_NAMES,
  deriveCurrentStateDebt,
  type CurrentStateInputMode,
} from "./current-state-debt";

/** Keyed by the field's own `name` attribute — the same shape `preserveFields`
 *  returns for redisplay after a validation error, so call sites pass it
 *  through with no translation layer. */
export type CurrentStateDebtInitialValues = Partial<
  Record<(typeof CURRENT_STATE_DEBT_FIELD_NAMES)[number], string>
>;

function formatPercent(pct: number): string {
  return `${pct.toLocaleString("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} %`;
}

function formatEur(amountMinor: number): string {
  return `${formatMoneyInput(amountMinor)} €`;
}

export function CurrentStateDebtFields({
  baselineDate,
  idPrefix,
  initialValues,
  submitLabel,
}: {
  /** "Hoy" — the re-baseline date this declaration anchors on. */
  baselineDate: string;
  idPrefix: string;
  initialValues?: CurrentStateDebtInitialValues;
  /**
   * When present, this island renders its own submit button (disabled on
   * error/infeasible) — the advanced edit surface's dedicated current-state
   * form. Omitted in the wizard, whose shared pane button submits instead.
   */
  submitLabel?: string;
}) {
  const [outstandingBalance, setOutstandingBalance] = useState(
    initialValues?.csOutstandingBalance ?? "",
  );
  const [endDate, setEndDate] = useState(initialValues?.csEndDate ?? "");
  const [nextPaymentDate, setNextPaymentDate] = useState(
    initialValues?.csNextPaymentDate ?? suggestFirstPaymentDate(baselineDate),
  );
  const [inputMode, setInputMode] = useState<CurrentStateInputMode>(
    initialValues?.csInputMode === "payment" ? "payment" : "rate",
  );
  const [annualRatePercent, setAnnualRatePercent] = useState(
    initialValues?.csAnnualRate ?? "",
  );
  const [monthlyPayment, setMonthlyPayment] = useState(
    initialValues?.csMonthlyPayment ?? "",
  );
  const [originalSigningDate, setOriginalSigningDate] = useState(
    initialValues?.csOriginalSigningDate ?? "",
  );

  const derived = useMemo(
    () =>
      deriveCurrentStateDebt({
        annualRatePercent,
        baselineDate,
        endDate,
        inputMode,
        monthlyPayment,
        nextPaymentDate,
        originalSigningDate,
        outstandingBalance,
      }),
    [
      annualRatePercent,
      baselineDate,
      endDate,
      inputMode,
      monthlyPayment,
      nextPaymentDate,
      originalSigningDate,
      outstandingBalance,
    ],
  );

  const hasError = !derived.ok;
  // A pristine form (nothing typed yet) derives an error too (an empty saldo),
  // but that is not a mistake to flag red before the user has done anything.
  const pristine = outstandingBalance.trim() === "" && endDate.trim() === "";

  return (
    <>
      <label>
        <span>Saldo pendiente hoy</span>
        <input
          aria-label="Saldo pendiente hoy"
          inputMode="decimal"
          name="csOutstandingBalance"
          onChange={(event) => setOutstandingBalance(event.target.value)}
          placeholder="118.000,00"
          required={Boolean(submitLabel)}
          value={outstandingBalance}
        />
      </label>

      <label>
        <span>Fecha de fin</span>
        <input
          aria-label="Fecha de fin"
          min={baselineDate}
          name="csEndDate"
          onChange={(event) => setEndDate(event.target.value)}
          required={Boolean(submitLabel)}
          type="date"
          value={endDate}
        />
      </label>

      <label>
        <span>Próxima fecha de cuota</span>
        <input
          aria-label="Próxima fecha de cuota"
          min={baselineDate}
          name="csNextPaymentDate"
          onChange={(event) => setNextPaymentDate(event.target.value)}
          required={Boolean(submitLabel)}
          type="date"
          value={nextPaymentDate}
        />
      </label>
      <p className="infoNote">
        Su día del mes fija el día de cobro del resto de cuotas. Sugerimos una fecha
        cercana; ajústala a tu próximo recibo real.
      </p>

      <fieldset className="segmented" id={`${idPrefix}-input-mode`}>
        <legend>Dato del banco</legend>
        <label>
          <input
            checked={inputMode === "rate"}
            name="csInputMode"
            onChange={() => setInputMode("rate")}
            type="radio"
            value="rate"
          />
          <span>Tengo el tipo anual</span>
        </label>
        <label>
          <input
            checked={inputMode === "payment"}
            name="csInputMode"
            onChange={() => setInputMode("payment")}
            type="radio"
            value="payment"
          />
          <span>Tengo la cuota mensual</span>
        </label>
      </fieldset>

      {inputMode === "rate" ? (
        <label>
          <span>Tipo anual actual</span>
          <input
            aria-label="Tipo anual actual"
            inputMode="decimal"
            name="csAnnualRate"
            onChange={(event) => setAnnualRatePercent(event.target.value)}
            placeholder="2,35"
            value={annualRatePercent}
          />
        </label>
      ) : (
        <input name="csAnnualRate" type="hidden" value={annualRatePercent} />
      )}

      {inputMode === "payment" ? (
        <label>
          <span>Cuota mensual actual</span>
          <input
            aria-label="Cuota mensual actual"
            inputMode="decimal"
            name="csMonthlyPayment"
            onChange={(event) => setMonthlyPayment(event.target.value)}
            placeholder="1.758,75"
            value={monthlyPayment}
          />
        </label>
      ) : (
        <input name="csMonthlyPayment" type="hidden" value={monthlyPayment} />
      )}

      {pristine ? null : (
        <div aria-live="polite" className={hasError ? "errorBand" : "warningBand"}>
          {derived.ok ? (
            <>
              <span>
                {inputMode === "rate"
                  ? "Cuota mensual estimada"
                  : "Tipo anual equivalente"}
              </span>
              <strong>
                {inputMode === "rate"
                  ? formatEur(derived.monthlyPaymentMinor)
                  : formatPercent(Number(derived.annualInterestRate) * 100)}
              </strong>
              <p>
                {inputMode === "rate"
                  ? `Con estos datos tu cuota sale ${formatEur(derived.monthlyPaymentMinor)} al mes. ¿Cuadra con tu banco?`
                  : `Con estos datos el tipo sale ${formatPercent(Number(derived.annualInterestRate) * 100)} anual. ¿Cuadra con tu banco?`}
              </p>
            </>
          ) : (
            <p>{derived.error}</p>
          )}
        </div>
      )}

      <div className="debtBaselineTimeline" aria-label="Alcance histórico">
        <div>
          <span>Antes de hoy</span>
          <strong>Sin saldos inventados</strong>
        </div>
        <div>
          <span>Desde hoy</span>
          <strong>Plan amortizado</strong>
        </div>
      </div>

      <details className="anchorEdit">
        <summary>Firma original (opcional)</summary>
        <label>
          <span>Fecha de firma original</span>
          <input
            aria-label="Fecha de firma original"
            max={baselineDate}
            name="csOriginalSigningDate"
            onChange={(event) => setOriginalSigningDate(event.target.value)}
            type="date"
            value={originalSigningDate}
          />
        </label>
        <p className="infoNote">
          Solo identifica la deuda; los años anteriores a hoy no se reconstruyen.
        </p>
      </details>

      {submitLabel ? (
        <div className="formActions">
          <button disabled={hasError} type="submit">
            {submitLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}
