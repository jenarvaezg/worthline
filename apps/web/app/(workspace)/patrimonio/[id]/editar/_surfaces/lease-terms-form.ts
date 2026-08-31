/**
 * The lease terms of a declared rent — vocabulary, parsing and the sentence the
 * ficha prints (#1521). Pure: no React, no DB (interaction-patterns §7).
 *
 * Three declarations, and the point of all three is to stop worthline assuming an
 * answer it never got. Before them, a `end_date` already in the past meant «esta
 * renta desaparece para siempre»: honest for a season's let, an invention for a
 * long-term residential lease, which continues past its signed date by law. The
 * invention was quiet AND it moved figures — two of Jorge's flats were due to drop
 * from their declared net yield to the housing rung's 3 % on 2026-10-01, lowering
 * his expected return and moving his FIRE date without him touching anything.
 *
 * Declaring nothing keeps every figure where it was; what changes is that the ficha
 * now SAYS which assumption is standing in ({@link leaseTermsSpec}).
 */

import type {
  LeaseRegime,
  PayoutSchedule,
  PostMandatoryTermPolicy,
  RentRevision,
} from "@worthline/domain";
import { effectivePostMandatoryTermPolicy } from "@worthline/domain";

/** The empty `<select>` value: «no lo he dicho», never a default in disguise. */
const UNDECLARED = "";

/** The label every one of these selects opens on. One identity, one string. */
export const LEASE_TERM_UNDECLARED_LABEL = "Sin declarar";

/** The regimes in render order, with their Spanish labels. */
export const LEASE_REGIME_OPTIONS: ReadonlyArray<{
  value: LeaseRegime;
  label: string;
}> = [
  { value: "residential_long_term", label: "Vivienda habitual (larga duración)" },
  { value: "seasonal", label: "Temporada" },
  { value: "vacation", label: "Vacacional / turístico" },
  { value: "other", label: "Otro" },
];

/** How the rent is revised. The two nominal ones are what stop the FIRE rate. */
export const RENT_REVISION_OPTIONS: ReadonlyArray<{
  value: RentRevision;
  label: string;
}> = [
  { value: "legal_reference", label: "Por referencia legal (IRAV, IPC…)" },
  { value: "contractual", label: "Por una cláusula del contrato" },
  { value: "fixed", label: "Renta fija, sin revisión" },
  { value: "none", label: "No se revisa" },
];

/** What the owner does once the mandatory term is over. */
export const POST_MANDATORY_TERM_POLICY_OPTIONS: ReadonlyArray<{
  value: PostMandatoryTermPolicy;
  label: string;
}> = [
  { value: "renew_same_real_rent", label: "Sigue alquilado por la misma renta real" },
  { value: "stop", label: "Deja de rentar" },
  { value: "unknown", label: "Todavía no lo sé" },
];

const LEASE_REGIME_LABEL = new Map(
  LEASE_REGIME_OPTIONS.map(({ value, label }) => [value, label]),
);
const RENT_REVISION_LABEL = new Map(
  RENT_REVISION_OPTIONS.map(({ value, label }) => [value, label]),
);

/** The raw lease-term fields lifted straight off the form. `""` = not declared. */
export interface LeaseTermsFields {
  leaseRegime: string;
  rentRevision: string;
  /** Free label for a `legal_reference` revision (e.g. "IRAV"). Documentary only. */
  rentRevisionReference: string;
  postMandatoryTermPolicy: string;
}

/** A validated lease-terms write. Every field is explicit, and `null` means undeclared. */
export interface ParsedLeaseTerms {
  leaseRegime: LeaseRegime | null;
  rentRevision: RentRevision | null;
  rentRevisionReference: string | null;
  postMandatoryTermPolicy: PostMandatoryTermPolicy | null;
}

export type LeaseTermsResult =
  | { ok: true; terms: ParsedLeaseTerms }
  | { ok: false; error: string };

/**
 * One optional declaration off one select: blank is `null`, a listed value is itself,
 * anything else is an error. The three fields differ only in their vocabulary and
 * their message, so they share the walk instead of repeating it three times.
 */
function parseVocabulary<T extends string>(
  raw: string,
  options: ReadonlyArray<{ value: T }>,
  error: string,
): { ok: true; value: T | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === UNDECLARED) {
    return { ok: true, value: null };
  }
  const match = options.find(({ value }) => value === trimmed);
  return match ? { ok: true, value: match.value } : { ok: false, error };
}

/**
 * Parse the three declarations. Each is optional on its own — a user may know the
 * regime and not the policy — so an empty field is `null`, never an error.
 *
 * The free reference only survives on a `legal_reference` revision: keeping «IRAV»
 * beside «renta fija» would leave a label contradicting the field it annotates, and
 * a reader would have no way to tell which of the two is the declaration.
 */
export function parseLeaseTerms(fields: LeaseTermsFields): LeaseTermsResult {
  const regime = parseVocabulary(
    fields.leaseRegime,
    LEASE_REGIME_OPTIONS,
    "Selecciona un régimen de alquiler válido.",
  );
  if (!regime.ok) {
    return regime;
  }
  const revision = parseVocabulary(
    fields.rentRevision,
    RENT_REVISION_OPTIONS,
    "Selecciona una forma de revisión válida.",
  );
  if (!revision.ok) {
    return revision;
  }
  const policy = parseVocabulary(
    fields.postMandatoryTermPolicy,
    POST_MANDATORY_TERM_POLICY_OPTIONS,
    "Selecciona qué pasa al terminar el plazo obligatorio.",
  );
  if (!policy.ok) {
    return policy;
  }
  const reference = fields.rentRevisionReference.trim();
  return {
    ok: true,
    terms: {
      leaseRegime: regime.value,
      rentRevision: revision.value,
      rentRevisionReference:
        revision.value === "legal_reference" && reference ? reference : null,
      postMandatoryTermPolicy: policy.value,
    },
  };
}

/** What the ficha prints under a declared rent: the terms, and the assumption in force. */
export interface LeaseTermsSpec {
  /** One line: regime · revision · what happens at the end, and where that came from. */
  spec: string;
  /**
   * The nominal-rent warning, or null. Separate from `spec` because it is the one
   * clause that says a figure is being withheld — it earns its own emphasis, and the
   * FIRE panel says the same thing from the other side (`nominal_rent_revision`).
   */
  warning: string | null;
}

/**
 * The sentence for one declared rent. It always says what happens at the end of the
 * lease, INCLUDING when nobody declared it — that silence is what #1521 closes, and
 * an empty field cannot explain a rate that quietly dropped to 3 %.
 */
export function leaseTermsSpec(
  schedule: Pick<
    PayoutSchedule,
    "leaseRegime" | "rentRevision" | "rentRevisionReference" | "postMandatoryTermPolicy"
  >,
): LeaseTermsSpec {
  const clauses: string[] = [
    schedule.leaseRegime == null
      ? "régimen sin declarar"
      : (LEASE_REGIME_LABEL.get(schedule.leaseRegime) ?? schedule.leaseRegime),
  ];

  if (schedule.rentRevision != null) {
    const label = RENT_REVISION_LABEL.get(schedule.rentRevision) ?? schedule.rentRevision;
    clauses.push(
      schedule.rentRevision === "legal_reference" && schedule.rentRevisionReference
        ? `revisión: ${label} — ${schedule.rentRevisionReference}`
        : `revisión: ${label}`,
    );
  } else {
    clauses.push("revisión sin declarar");
  }

  const { policy, source } = effectivePostMandatoryTermPolicy(schedule);
  const outcome =
    policy === "renew_same_real_rent"
      ? "al terminar el plazo obligatorio sigue rentando lo mismo en términos reales"
      : "al terminar deja de rentar y el activo vuelve al retorno por defecto de su tramo";
  const provenance =
    source === "declared"
      ? "lo has declarado"
      : source === "regime"
        ? "por el régimen declarado"
        : "supuesto: nadie lo ha declarado";
  clauses.push(`${outcome} (${provenance})`);

  const nominal = schedule.rentRevision === "fixed" || schedule.rentRevision === "none";
  return {
    spec: clauses.join(" · "),
    warning: nominal
      ? "Una renta que no se revisa pierde poder de compra cada año, así que tu FIRE no la lee como rentabilidad real: se queda el retorno por defecto de su tramo."
      : null,
  };
}
