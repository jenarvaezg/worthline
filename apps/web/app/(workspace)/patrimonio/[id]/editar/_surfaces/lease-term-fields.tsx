/**
 * The four lease-term inputs (#1521), rendered identically wherever they appear: on
 * the «declarar un cobro recurrente» form, where there is no schedule yet, and under
 * an already-declared rent, where they are prefilled from it.
 *
 * One component rather than two copies because the two places must never drift: they
 * post the SAME field names to the same parser, and an option that existed in one and
 * not the other would be a declaration a user could make on one screen and not on the
 * other.
 */

import type { PayoutSchedule } from "@worthline/domain";
import {
  LEASE_REGIME_OPTIONS,
  LEASE_TERM_UNDECLARED_LABEL,
  POST_MANDATORY_TERM_POLICY_OPTIONS,
  RENT_REVISION_OPTIONS,
} from "./lease-terms-form";

/** The declared terms to prefill from, or null on the form that has no schedule yet. */
export type LeaseTermValues = Pick<
  PayoutSchedule,
  "leaseRegime" | "rentRevision" | "rentRevisionReference" | "postMandatoryTermPolicy"
> | null;

function LeaseTermSelect({
  ariaLabel,
  defaultValue,
  label,
  name,
  options,
}: {
  ariaLabel: string | undefined;
  defaultValue: string;
  label: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label>
      {label}
      <select
        {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
        defaultValue={defaultValue}
        name={name}
      >
        {/* Always first, always blank: the form asks, it never guesses. */}
        <option value="">{LEASE_TERM_UNDECLARED_LABEL}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LeaseTermFields({
  ofLabel,
  values,
}: {
  /**
   * The rent these fields belong to, when there is one — it disambiguates the
   * accessible names on a page listing several rents under the same visible labels.
   * Omitted on the alta form, which has exactly one set.
   */
  ofLabel?: string;
  values: LeaseTermValues;
}) {
  const suffix = ofLabel ? ` de ${ofLabel}` : "";
  return (
    <>
      <LeaseTermSelect
        ariaLabel={ofLabel ? `Régimen de alquiler${suffix}` : undefined}
        defaultValue={values?.leaseRegime ?? ""}
        label="Régimen"
        name="leaseRegime"
        options={LEASE_REGIME_OPTIONS}
      />
      <LeaseTermSelect
        ariaLabel={ofLabel ? `Revisión de la renta${suffix}` : undefined}
        defaultValue={values?.rentRevision ?? ""}
        label="Revisión de la renta"
        name="rentRevision"
        options={RENT_REVISION_OPTIONS}
      />
      <label>
        Referencia
        <input
          aria-label={`Referencia de revisión${suffix || " de la renta"}`}
          autoComplete="off"
          defaultValue={values?.rentRevisionReference ?? ""}
          name="rentRevisionReference"
          placeholder="IRAV"
        />
      </label>
      <LeaseTermSelect
        ariaLabel={
          ofLabel ? `Qué pasa al terminar el plazo obligatorio${suffix}` : undefined
        }
        defaultValue={values?.postMandatoryTermPolicy ?? ""}
        label="Al terminar el plazo obligatorio"
        name="postMandatoryTermPolicy"
        options={POST_MANDATORY_TERM_POLICY_OPTIONS}
      />
    </>
  );
}
