/**
 * The alta's identifier field — per instrument since #1746 (was `IsinField`, #1489).
 *
 * It used to be a hidden input, filled only when the user picked a result from the
 * symbol search. Type the symbol by hand instead — the fallback the wizard offers in
 * as many words — and the position was born with an empty identifier, in silence.
 * That is not a missing label: the instrument identity is the typed pair (ISIN or
 * DGS code, #1667), so an unidentified holding is invisible to a broker statement
 * (which routes by identifier), inherits no exposure profile, and cannot be
 * recognized as the same product as anything else. A real user was told his own ETF
 * was a different one.
 *
 * So the field is VISIBLE and says what it is for. What it ASKS depends on the
 * instrument already chosen (decisión 9 del mapa #1454): «Código DGS del plan» for a
 * pension plan — which has no ISIN and never will — «ISIN» for a fund, ETF, stock or
 * index. Never a kind selector, never a hidden `required`: the instrument was picked
 * one radio group above, and the field derives everything from it. An instrument with
 * no identifier at all (crypto) renders NOTHING, from the same domain map the health
 * signal reads, so the question and the warning can never disagree.
 *
 * Still optional — «identificado, sin cotizar» and «sin identificar» are both
 * legitimate states, and blocking an alta over reference metadata would be worse —
 * but never empty without the user having seen it.
 *
 * With `search`, the field grows the plan's «Buscar plan» button (variante A de
 * #1669): the identifier SEEDS the symbol search instead of a second box asking for
 * a code the user does not have. It is the same GET sub-form recipe as the symbol
 * search — no client JS (ADR 0009/0036).
 *
 * One component for the two altas so both ask the same question with the same words;
 * `className` is what lets the simple wizard dress it as a `simpleField` and the
 * advanced form leave it in its own bare-label layout.
 */

import { securityIdFieldCopy } from "@web/security-id-field-copy";
import type { Instrument } from "@worthline/domain";
import { securityIdFieldForInstrument } from "@worthline/domain";

/** The form field an instrument's identifier is posted under. */
export function securityIdFieldName(instrument: Instrument): string {
  return `securityId_${instrument}`;
}

export function SecurityIdField({
  className,
  instrument,
  search,
  value,
}: {
  /** The wrapper class of the surrounding form's fields, when it has one. */
  className?: string | undefined;
  /** The investment group this field belongs to — it decides WHICH identifier. */
  instrument: Instrument;
  /**
   * Where the «buscar» button submits, when this identifier seeds the search
   * (variante A, #1669). A GET on the alta's own path: the server resolves the code
   * and renders the candidate, and picking it is a plain navigation.
   */
  search?: { basePath: string; label: string } | undefined;
  /** The identifier already in hand: the search's prefill, or the user's own entry. */
  value: string | undefined;
}) {
  const field = securityIdFieldForInstrument(instrument);

  if (!field) return null;

  const copy = securityIdFieldCopy(field.kind);
  const input = (
    <input
      autoComplete="off"
      defaultValue={value}
      name={securityIdFieldName(instrument)}
      placeholder={copy.placeholder}
    />
  );

  return (
    <label className={className}>
      <span>{copy.altaLabel} (opcional)</span>
      {search ? (
        <span className="symbolSearchRow">
          {input}
          <button formAction={search.basePath} formMethod="get">
            {search.label}
          </button>
        </span>
      ) : (
        input
      )}
      <small>{copy.help}</small>
    </label>
  );
}
