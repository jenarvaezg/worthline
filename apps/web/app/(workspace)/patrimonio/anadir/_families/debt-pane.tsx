/**
 * The debt family's alta pane (#1700), beside {@link runDebtAlta}.
 *
 * Two blocks that never both apply, and the kind picked above decides which one
 * the reveal CSS hides: hipoteca/préstamo take «alta por estado actual» (ADR
 * 0056, #677), tarjeta is revolving and keeps the plain balance field. Which
 * block each kind hides is declared in the drawers table, not spelled again here
 * — the class names come from {@link debtBlockProps}.
 */

import { CurrentStateDebtFields } from "@web/patrimonio/current-state-debt-fields";
import {
  DEBT_KIND_FIELD,
  DEBT_KINDS,
  DEFAULT_DEBT_KIND,
  debtBlockProps,
  drawerPaneProps,
} from "./alta-drawers";
import {
  Field,
  PaneActions,
  PaneHeader,
  type PaneValues,
  RadioChoice,
  paneValue as v,
} from "./pane-shell";

export function DebtPane({ today, values }: { today: string; values: PaneValues }) {
  const selected = v(values, DEBT_KIND_FIELD) ?? DEFAULT_DEBT_KIND;

  return (
    <div {...drawerPaneProps("deuda")}>
      <PaneHeader title="Deuda" text="Saldo pendiente y tipo de obligación." />
      <fieldset className="simpleChoiceGroup">
        <legend>Tipo de deuda</legend>
        {DEBT_KINDS.map((kind) => (
          <RadioChoice
            checked={selected === kind.id}
            key={kind.id}
            label={kind.label}
            name={DEBT_KIND_FIELD}
            value={kind.id}
          />
        ))}
      </fieldset>
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_deuda")}
          name="simpleName_deuda"
          placeholder="Hipoteca de casa"
        />
      </Field>

      {/* Tarjeta: no admite «alta por estado actual» (revolving, sin plan). */}
      <div {...debtBlockProps("balanceField")}>
        <Field label="Saldo pendiente">
          <input
            defaultValue={v(values, "simpleValue_deuda")}
            inputMode="decimal"
            name="simpleValue_deuda"
            placeholder="120.000,00"
          />
        </Field>
      </div>

      {/* Hipoteca/préstamo: «alta por estado actual» (ADR 0056, #677) — el
          camino por defecto para una deuda antigua. Deja «Fecha de fin» en
          blanco para dar de alta solo el saldo y rellenar el plan más tarde. */}
      <div {...debtBlockProps("currentStateBlock")}>
        <p className="simpleHint">
          Recomendado para una deuda antigua: lo que debes hoy, cuándo termina y tu cuota
          o tipo actual.
        </p>
        <CurrentStateDebtFields
          baselineDate={today}
          idPrefix="wizard-deuda"
          initialValues={values}
        />
      </div>

      <p className="simpleHint">
        Vincularla a un inmueble y el cuadro de pagos se añaden luego en su ficha.
      </p>
      <PaneActions />
    </div>
  );
}
