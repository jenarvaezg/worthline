/**
 * The alta's ISIN field (#1489).
 *
 * It used to be a hidden input, filled only when the user picked a result from the
 * symbol search. Type the symbol by hand instead — the fallback the wizard offers in
 * as many words — and the position was born with an empty ISIN, in silence. That is
 * not a missing label: the instrument identity is `isin ?? providerSymbol` (ADR 0055,
 * #539), so a symbol-only holding is invisible to a broker statement (which routes by
 * ISIN), inherits no exposure profile, and cannot be recognized as the same product as
 * anything else. A real user was told his own ETF was a different one.
 *
 * So the field is VISIBLE and says what it is for. Still optional — a pension plan
 * often has no ISIN, and blocking an alta over reference metadata would be worse — but
 * never empty without the user having seen it. When the symbol search resolved a
 * candidate, `value` arrives prefilled from it (`pfIsin`), which is the "or derives it"
 * half of the fix: on the ordinary path the field fills itself.
 *
 * One component for the two altas so both ask the same question with the same words;
 * `className` is what lets the simple wizard dress it as a `simpleField` and the
 * advanced form leave it in its own bare-label layout.
 */

export function IsinField({
  className,
  instrument,
  value,
}: {
  /** The wrapper class of the surrounding form's fields, when it has one. */
  className?: string | undefined;
  /** The investment group this field belongs to — the form-field suffix. */
  instrument: string;
  /** The ISIN already in hand: the search's prefill, or the user's own entry. */
  value: string | undefined;
}) {
  return (
    <label className={className}>
      <span>ISIN (opcional)</span>
      <input
        autoComplete="off"
        defaultValue={value}
        name={`isin_${instrument}`}
        placeholder="IE00B52MJY50"
      />
      <small>
        El código que identifica el producto. Con él, un extracto de tu bróker reconoce
        esta posición y hereda su ficha de exposición; sin él, no. Si eliges un resultado
        de la búsqueda, lo rellenamos nosotros.
      </small>
    </label>
  );
}
