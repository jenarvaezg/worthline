/**
 * The two panes of the stored family (#1700), beside {@link runStoredAlta}: a
 * figure somebody typed, with no ledger and no curve behind it.
 *
 * Two drawers, one family: «Dinero» (cash, plus the a-plazo flag) and «Otro
 * bien» (a car, gold, an object) both persist through the manual-asset path, so
 * their panes live next to the command that writes them.
 */

import { drawerPaneProps } from "./alta-drawers";
import {
  Field,
  PaneActions,
  PaneHeader,
  type PaneValues,
  RadioChoice,
  paneValue as v,
} from "./pane-shell";

/** The optional fine type of «Otro bien». Never required — «Otro» is the default. */
const ASSET_KINDS = [
  { id: "vehicle", label: "Coche" },
  { id: "precious_metal", label: "Oro" },
  { id: "other", label: "Otro" },
] as const;

const DEFAULT_ASSET_KIND = "other";

export function MoneyPane({ values }: { values: PaneValues }) {
  return (
    <div {...drawerPaneProps("dinero")}>
      <PaneHeader title="Dinero" text="Cuenta corriente, efectivo o depósito a plazo." />
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_dinero")}
          name="simpleName_dinero"
          placeholder="Cuenta del banco"
        />
      </Field>
      <Field label="Importe actual">
        <input
          defaultValue={v(values, "simpleValue_dinero")}
          inputMode="decimal"
          name="simpleValue_dinero"
          placeholder="2.500,00"
        />
      </Field>
      <label className="simpleInlineCheck">
        <input
          defaultChecked={v(values, "cashTerm_dinero") === "on"}
          name="cashTerm_dinero"
          type="checkbox"
        />
        <span>A plazo fijo</span>
      </label>
      <PaneActions />
    </div>
  );
}

export function OtherAssetPane({ values }: { values: PaneValues }) {
  const selected = v(values, "simpleAssetKind") ?? DEFAULT_ASSET_KIND;

  return (
    <div {...drawerPaneProps("bien")}>
      <PaneHeader title="Otro bien" text="Coche, oro u otro activo mantenido a mano." />
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_bien")}
          name="simpleName_bien"
          placeholder="Renault Clio"
        />
      </Field>
      <Field label="Importe actual">
        <input
          defaultValue={v(values, "simpleValue_bien")}
          inputMode="decimal"
          name="simpleValue_bien"
          placeholder="8.500,00"
        />
      </Field>
      <fieldset className="simpleChoiceGroup">
        <legend>Tipo (opcional)</legend>
        {ASSET_KINDS.map((kind) => (
          <RadioChoice
            checked={selected === kind.id}
            key={kind.id}
            label={kind.label}
            name="simpleAssetKind"
            value={kind.id}
          />
        ))}
      </fieldset>
      <PaneActions />
    </div>
  );
}
