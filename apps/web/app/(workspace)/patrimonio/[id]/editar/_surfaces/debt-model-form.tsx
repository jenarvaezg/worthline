/**
 * «Modelo de deuda»: how the debt's balance moves in the history (PRD #109), and —
 * for a model with a curve that can be drawn two ways — its valuation cadence
 * (ADR 0031, #393). The ficha's side panel (#1848).
 *
 * Saving the model re-renders the ficha with the tabs of the model chosen, so the
 * form returns to the bare ficha, which opens on that model's default tab.
 */

import type { FormErrorContext } from "@web/intake";
import { setDebtModelAction, setValuationCadenceAction } from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { DebtModel, ValuationCadence } from "@worthline/domain";
import { DEBT_FORM_ID, FormRefusal } from "./debt-form-ids";
import { DEBT_MODEL_LABELS } from "./debt-format";

export function DebtModelForm({
  currentUrl,
  debtModel,
  formError,
  liabilityId,
  readOnly = false,
  valuationCadence,
}: {
  /** Where both forms return: the bare ficha. */
  currentUrl: string;
  debtModel: DebtModel | null;
  formError: FormErrorContext | null;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  liabilityId: string;
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  /** Stored valuation cadence (ADR 0031); null reads as the default `step`. */
  valuationCadence: ValuationCadence | null;
}) {
  return (
    <div className="debtSurface">
      <form action={setDebtModelAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <FormRefusal formError={formError} formId={DEBT_FORM_ID.model} />
        <label>
          Modelo de deuda
          <select
            aria-label="Modelo de deuda"
            defaultValue={debtModel ?? ""}
            name="debtModel"
          >
            <option value="">Sin modelo</option>
            <option value="amortizable">{DEBT_MODEL_LABELS.amortizable}</option>
            <option value="revolving">{DEBT_MODEL_LABELS.revolving}</option>
            <option value="informal">{DEBT_MODEL_LABELS.informal}</option>
          </select>
        </label>
        <p className="infoNote">
          Elige cómo evoluciona el saldo de la deuda en el histórico. Al cambiarlo se
          muestra el formulario correspondiente.
        </p>
        <PendingSubmit disabled={readOnly} pendingLabel="Guardando…">
          Guardar modelo
        </PendingSubmit>
      </form>

      {debtModel === "amortizable" || debtModel === "revolving" ? (
        <details
          suppressHydrationWarning
          className="anchorEdit"
          open={formError?.formId === DEBT_FORM_ID.cadence}
        >
          <summary>Avanzado</summary>
          <form action={setValuationCadenceAction} className="stackForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <FormRefusal formError={formError} formId={DEBT_FORM_ID.cadence} />
            <label>
              Cadencia de valoración
              <select
                aria-label="Cadencia de valoración"
                defaultValue={valuationCadence ?? "step"}
                name="cadence"
              >
                <option value="step">Escalonado (por defecto)</option>
                <option value="interpolated">Interpolado (suave a diario)</option>
              </select>
            </label>
            <p className="infoNote">
              Escalonado mantiene el último saldo conocido hasta el siguiente evento;
              interpolado dibuja una línea suave entre eventos en el histórico.
            </p>
            <PendingSubmit disabled={readOnly} pendingLabel="Guardando…">
              Guardar cadencia
            </PendingSubmit>
          </form>
        </details>
      ) : null}
    </div>
  );
}
