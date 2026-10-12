/**
 * The recurrence proper of an income — concept, amount, cadence, from, until — as
 * both doors ask it and as a row with no asset is corrected (#1813). One markup, so
 * the correction posts exactly the fields the door posts, to the same parser.
 *
 * Rendered inside the caller's `.cobrosFormGrid`: the door adds the costs and lease
 * terms of a holding beside them.
 */

import type { RecurrenceCoreFields } from "./income-recurrence";
import { PAYOUT_CADENCE_LABELS } from "./income-recurrence";

export function IncomeRecurrenceInputs({
  accessibleSuffix,
  linked,
  today,
  values,
}: {
  /**
   * Appended to every field's accessible name where another form on the page asks
   * the same visible labels — the ficha's one-off payout, or the other rows of the
   * Rentas list. Absent: the visible labels are the names.
   */
  accessibleSuffix?: string | undefined;
  /** Whether a holding generates it: only the placeholder of the concept changes. */
  linked: boolean;
  /** The start a new declaration opens on. */
  today: string;
  /** What to prefill: a stored recurrence, or the fields a refused post typed. */
  values: Readonly<Partial<RecurrenceCoreFields>>;
}) {
  const named = (name: string) =>
    accessibleSuffix === undefined ? {} : { "aria-label": `${name}${accessibleSuffix}` };

  return (
    <>
      <label>
        Concepto
        <input
          {...named("Concepto")}
          aria-required="true"
          autoComplete="off"
          defaultValue={values.label ?? ""}
          name="label"
          placeholder={linked ? "Alquiler, cupón…" : "Pensión, nómina…"}
        />
      </label>
      <label>
        Importe
        <input
          {...named("Importe")}
          aria-required="true"
          defaultValue={values.amount ?? ""}
          inputMode="decimal"
          name="amount"
          placeholder="0,00"
        />
      </label>
      <label>
        Cadencia
        <select
          {...named("Cadencia")}
          defaultValue={values.cadence || "monthly"}
          name="cadence"
        >
          {PAYOUT_CADENCE_LABELS.map(({ cadence, label }) => (
            <option key={cadence} value={cadence}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Desde
        <input
          {...named("Fecha de inicio")}
          defaultValue={values.startISO || today}
          name="startISO"
          type="date"
        />
      </label>
      <label>
        Hasta (opcional)
        <input
          {...named("Fecha de fin")}
          defaultValue={values.endISO ?? ""}
          name="endISO"
          type="date"
        />
      </label>
    </>
  );
}
