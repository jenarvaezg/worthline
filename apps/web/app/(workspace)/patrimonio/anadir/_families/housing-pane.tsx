/**
 * The housing family's alta pane (#1700), beside {@link runHousingAlta}: a value
 * today and whether this is the primary residence. Purchase, appraisals and the
 * appreciation cadence are the ficha's business, never the wizard's.
 */

import { drawerPaneProps } from "./alta-drawers";
import {
  Field,
  PaneActions,
  PaneHeader,
  type PaneValues,
  paneValue as v,
} from "./pane-shell";

export function HousingPane({
  hasPrimaryResidence,
  values,
}: {
  /** Whether the workspace already has one — the first property defaults to yes. */
  hasPrimaryResidence: boolean;
  values: PaneValues;
}) {
  return (
    <div {...drawerPaneProps("inmueble")}>
      <PaneHeader
        title="Inmueble"
        text="Valor actual y si cuenta como vivienda habitual."
      />
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_inmueble")}
          name="simpleName_inmueble"
          placeholder="Mi casa"
        />
      </Field>
      <Field label="Valor actual">
        <input
          defaultValue={v(values, "simpleValue_inmueble")}
          inputMode="decimal"
          name="simpleValue_inmueble"
          placeholder="300.000,00"
        />
      </Field>
      <label className="simpleInlineCheck">
        <input
          defaultChecked={
            v(values, "primaryResidence_inmueble") !== undefined
              ? v(values, "primaryResidence_inmueble") !== "off"
              : !hasPrimaryResidence
          }
          name="primaryResidence_inmueble"
          type="checkbox"
        />
        <input name="primaryResidence_inmueble" type="hidden" value="off" />
        <span>Vivienda habitual</span>
      </label>
      <p className="simpleHint">
        Compra, tasaciones y ritmo de revalorización van luego en su ficha.
      </p>
      <PaneActions />
    </div>
  );
}
