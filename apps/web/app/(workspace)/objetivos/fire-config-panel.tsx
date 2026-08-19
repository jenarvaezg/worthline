/**
 * «Tus supuestos» — the FIRE config, living beside the figures it governs (#1450).
 *
 * This form used to be a section of /ajustes: the user edited spending, withdrawal
 * rate, savings and target age on one screen and read their consequences on
 * another. It moved here whole — a move and not a copy, because two synchronized
 * forms would be two sources of truth for one scope config.
 *
 * Every editable field carries ONE line saying what it MOVES, not what it is: read
 * top to bottom they give the engine's mental model. The two figures that are not
 * typed — the derived age (#1415) and the real return (#1448) — are read-only rows
 * with their provenance, because a blank where a value is expected reads as
 * something nobody filled in. The fine print (manual rate, per-tier rates, Lean/Fat,
 * barista income) folds away: it is part of the same single source of truth, so it
 * travels with the form, but it is not what a user comes here to change.
 *
 * Server-rendered with a Server Action (interaction-patterns §1): the save is a
 * mutation of authoritative data, and `PendingSubmit` announces it in flight.
 */

import { PendingSubmit } from "@web/pending-submit";
import type {
  FireAgeSource,
  FireScopeConfig,
  MonthlySavingsSuggestion,
} from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import type { FireAssumptionDraft } from "./fire-assumption-draft";
import { saveFireConfigAction } from "./fire-config-actions";
import {
  FIRE_TIER_FIELDS,
  fireConfigFieldValues,
  fireCurrentAgeReadout,
  fireReturnReadout,
  fireSavingsPlaceholder,
  fireSavingsSuggestionLine,
} from "./fire-config-form-view";

export interface FireConfigPanelProps {
  ageSource: FireAgeSource | null;
  config: FireScopeConfig | null;
  /** The page's own URL, so the action returns to the figures it just moved. */
  currentUrl: string;
  currency: string;
  /** Lo tecleado ahora mismo: el estado vive en la isla, que previsualiza con él. */
  draft: FireAssumptionDraft;
  /** The FIRE form's error, when the last save bounced. */
  errorMessage: string | null;
  onDraftChange: (draft: FireAssumptionDraft) => void;
  /** Hay cambios sin guardar, y las cifras de al lado son una previsualización. */
  previewing: boolean;
  privacyMode: boolean;
  /** The rate the projection actually used, for the read-only return row. */
  realReturnUsed: number | null;
  savingsSuggestion: MonthlySavingsSuggestion;
  /** null when no scope is selected: there is nothing to configure. */
  scopeId: string | null;
  /** #1416: the v56 migration wrote this savings capacity; it asks to be checked. */
  seededFromPlan: boolean;
}

export function FireConfigPanel({
  ageSource,
  config,
  currency,
  currentUrl,
  draft,
  errorMessage,
  onDraftChange,
  previewing,
  privacyMode,
  realReturnUsed,
  savingsSuggestion,
  scopeId,
  seededFromPlan,
}: FireConfigPanelProps) {
  const formatMoney = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  const values = fireConfigFieldValues(config);
  // Los cuatro editables son controlados porque la isla previsualiza con ellos; el
  // `<form>` sigue siendo un POST real, así que sin JavaScript se guarda igual.
  const editField =
    (field: keyof FireAssumptionDraft) => (event: { target: { value: string } }) =>
      onDraftChange({ ...draft, [field]: event.target.value });
  const age = fireCurrentAgeReadout({ ageSource, config });
  const rate = fireReturnReadout({ config, realReturnUsed });
  const savingsHint = fireSavingsSuggestionLine(savingsSuggestion, formatMoney);

  return (
    <section
      aria-label="Tus supuestos"
      className="firePanel fireConfigPanel"
      id="supuestos"
      /* Destino de las anclas «#supuestos» del panel de resultados: sin esto el
         salto mueve la vista pero no el foco, y el teclado sigue donde estaba. */
      tabIndex={-1}
    >
      <div className="panelHeader">
        <h3>Tus supuestos</h3>
        <span>editas aquí, ves ahí</span>
      </div>

      {errorMessage ? (
        <p className="formError" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {scopeId === null ? (
        <p className="muted">Selecciona un ámbito para configurar tu FIRE.</p>
      ) : (
        <form action={saveFireConfigAction} className="stackForm fireConfigForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="scopeId" type="hidden" value={scopeId} />

          <label>
            Gasto mensual (€)
            <input
              inputMode="decimal"
              name="monthlySpending"
              onChange={editField("monthlySpending")}
              placeholder="2000"
              value={draft.monthlySpending}
            />
            <small className="muted">
              Lo que quieres poder gastar cuando vivas de tu patrimonio. Define tu número
              FIRE: gasto anual ÷ tasa de retirada.
            </small>
          </label>

          <label>
            Tasa de retirada (%)
            <input
              inputMode="decimal"
              name="safeWithdrawalRate"
              onChange={editField("safeWithdrawalRate")}
              value={draft.safeWithdrawalRate}
            />
            <small className="muted">
              El porcentaje del capital que retiras al año sin agotarlo. Más baja = más
              prudente = número FIRE más alto.
            </small>
          </label>

          <label>
            Ahorro mensual (€)
            <input
              inputMode="decimal"
              name="monthlySavingsCapacity"
              onChange={editField("monthlySavingsCapacity")}
              placeholder={fireSavingsPlaceholder(savingsSuggestion)}
              value={draft.monthlySavingsCapacity}
            />
            <small className="muted">
              Lo que añades cada mes: marca la velocidad a la que llegas, no el objetivo.
              Es la única cifra de ahorro que usa la proyección FIRE: tu plan de
              aportaciones no la pisa.
            </small>
            {savingsHint ? <small className="muted">{savingsHint}</small> : null}
          </label>

          {seededFromPlan ? (
            <p className="warningBand">
              Hemos puesto este ahorro mensual con el total de tu plan de aportaciones,
              que es lo que la proyección usaba antes. Revísalo: aquí va lo que ahorras
              cada mes, no solo lo que aportas a un destino.
            </p>
          ) : null}

          <label>
            Edad objetivo de jubilación
            <input
              inputMode="numeric"
              name="targetRetirementAge"
              onChange={editField("targetRetirementAge")}
              value={draft.targetRetirementAge}
            />
            <small className="muted">
              Cuándo quieres jubilarte. Fija el Coast: cuánto necesitas tener ya para
              llegar sin aportar nada más.
            </small>
          </label>

          {/* Las dos cifras que NO se teclean, con su procedencia (#1415, #1448):
              sin ellas el panel parecería tener campos que el usuario dejó vacíos. */}
          <dl className="fireConfigReadouts">
            <div className="fireConfigReadout">
              <dt>Edad actual</dt>
              <dd>
                <strong>{age.value}</strong>
                <span className="fireConfigReadoutGloss">{age.gloss}</span>
              </dd>
            </div>
            <div className="fireConfigReadout">
              <dt>Retorno real</dt>
              <dd>
                <strong>{rate.value}</strong>
                <span className="fireConfigReadoutGloss">{rate.gloss}</span>
              </dd>
            </div>
          </dl>

          <details className="fireConfigFine" suppressHydrationWarning>
            <summary>Supuestos finos</summary>
            <div className="stackForm">
              <label>
                Retorno real esperado (%)
                <input
                  defaultValue={values.expectedRealReturn}
                  inputMode="decimal"
                  name="expectedRealReturn"
                  placeholder="estimado por tu mezcla"
                />
                <small className="muted">
                  Vacío = se pondera solo, y un inmueble con alquiler y gastos declarados
                  aporta su alquiler neto sobre su valor. Rellénalo para fijar un valor a
                  mano (anula la estimación, y con ella el alquiler declarado).
                </small>
              </label>

              {FIRE_TIER_FIELDS.map((tier) => (
                <label key={tier.key}>
                  Retorno real de {tier.label} (%)
                  <input
                    defaultValue={values.tierReturns[tier.key]}
                    inputMode="decimal"
                    name={`tierReturn_${tier.key}`}
                    placeholder={tier.defaultPercent}
                  />
                </label>
              ))}
              <small className="muted">
                Retornos reales anuales (tras inflación) por tipo de activo. Vacío = el
                valor por defecto de cada uno, el que ves de marca de agua.
              </small>

              <label>
                Multiplicador Lean FIRE
                <input
                  defaultValue={values.leanMultiplier}
                  inputMode="decimal"
                  name="leanMultiplier"
                  placeholder="0.7"
                />
                <small className="muted">
                  Fracción de tu gasto para el nivel Lean (por defecto 0,7).
                </small>
              </label>
              <label>
                Multiplicador Fat FIRE
                <input
                  defaultValue={values.fatMultiplier}
                  inputMode="decimal"
                  name="fatMultiplier"
                  placeholder="1.5"
                />
                <small className="muted">
                  Fracción de tu gasto para el nivel Fat (por defecto 1,5).
                </small>
              </label>
              <label>
                Ingreso a tiempo parcial (€/mes)
                <input
                  defaultValue={values.baristaIncome}
                  inputMode="decimal"
                  name="baristaIncome"
                  placeholder="0"
                />
                <small className="muted">
                  Barista FIRE: ingreso parcial que reduce el capital necesario. Vacío o 0
                  = sin efecto.
                </small>
              </label>
            </div>
          </details>

          {/* Las cifras de al lado ya se movieron, pero nada está escrito todavía:
              una previsualización que no se declara se lee como un guardado. */}
          {previewing ? (
            <p className="fireConfigPreviewing" role="status">
              Estás viendo el resultado de estos supuestos. Aún no se han guardado.
            </p>
          ) : null}

          {/* Una sola acción: los supuestos se guardan enteros o no se guardan. */}
          <PendingSubmit pendingLabel="Guardando…">Guardar supuestos</PendingSubmit>
        </form>
      )}
    </section>
  );
}
