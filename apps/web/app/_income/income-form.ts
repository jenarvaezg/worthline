/**
 * The declaration door of an income (#1673, S2 of #1522; ADR 0108). Pure: no
 * React, no DB (interaction-patterns §7).
 *
 * ONE parser for both doors — the Rentas surface, where an income needs no asset,
 * and the Cobros section of a holding's ficha, where the asset is already linked.
 * The two post the same field names here, so a declaration that is refused on one
 * is refused on the other and nothing can be saved by the side door.
 *
 * What it adds on top of the recurrence the ficha always parsed:
 *
 * - **nature** and **amount basis** are three-state: an empty value is «sin
 *   declarar» and is written as NULL — never a `passive`/`real` default the person
 *   did not choose. Undeclared income counts in no figure (ADR 0108), so the form
 *   says that out loud instead of hiding it behind a preselected option.
 * - **provenance** and its **cut-off date** are required. A figure copied by hand
 *   from an official simulation expires on its own; saving it without the date of
 *   the data it came from is #1508's defect again. The cut-off is the date of the
 *   DATA, never the day it was typed — so it has no default, and it cannot be
 *   later than today.
 * - the **condition** (the date through which the figure assumes the owner keeps
 *   contributing) is optional: absent means «no condition declared».
 */

import type {
  Income,
  IncomeAmountBasis,
  IncomeNature,
  IncomeProvenance,
} from "@worthline/domain";
import {
  buildPayoutScheduleResult,
  isValidISODate,
  type ParsedPayoutSchedule,
  type PayoutScheduleFields,
} from "./income-recurrence";

/** The three states of a declaration nobody has to make: «sin declarar» is `""`. */
type Undeclared = "";

/** The nature choices in render order — «sin declarar» first, and visible. */
export const INCOME_NATURE_CHOICES: ReadonlyArray<{
  value: IncomeNature | Undeclared;
  label: string;
}> = [
  { value: "", label: "Sin declarar" },
  { value: "passive", label: "Pasiva" },
  { value: "work", label: "Del trabajo" },
];

/** Whether the amount is in euros of today (real) or of each payment date (nominal). */
export const INCOME_AMOUNT_BASIS_CHOICES: ReadonlyArray<{
  value: IncomeAmountBasis | Undeclared;
  label: string;
}> = [
  { value: "", label: "Sin declarar" },
  { value: "real", label: "Euros de hoy" },
  { value: "nominal", label: "Euros de cada cobro" },
];

/** Where the figure comes from. No «sin declarar»: the door does not open without it. */
export const INCOME_PROVENANCE_CHOICES: ReadonlyArray<{
  value: IncomeProvenance;
  label: string;
}> = [
  { value: "official_simulation", label: "Simulación oficial" },
  { value: "user_estimate", label: "Estimación mía" },
];

/** The declaration fields proper — the part an existing income can be corrected on. */
export interface IncomeDeclarationFields {
  nature: string;
  amountBasis: string;
  provenance: string;
  provenanceAsOf: string;
  assumedContributionThrough: string;
}

const DECLARATION_FIELDS = [
  "nature",
  "amountBasis",
  "provenance",
  "provenanceAsOf",
  "assumedContributionThrough",
] as const satisfies ReadonlyArray<keyof IncomeDeclarationFields>;

/** Every field the declaration form posts, lifted straight off it. `""` = empty. */
export interface IncomeFields extends PayoutScheduleFields, IncomeDeclarationFields {}

/** A validated declaration: every field explicit, `null` meaning undeclared. */
export interface ParsedIncomeDeclaration {
  nature: IncomeNature | null;
  amountBasis: IncomeAmountBasis | null;
  provenance: IncomeProvenance;
  provenanceAsOf: string;
  assumedContributionThrough: string | null;
}

/**
 * A validated correction. The provenance and its cut-off are always there — the
 * door does not save without them — while a choice the form did not carry is
 * ABSENT and left untouched: «not sent» is not «sin declarar» (#1673 review; the
 * partial-form trap of `form-parcial-degrada-flag-booleano`).
 */
export type IncomeDeclarationPatch = Pick<
  ParsedIncomeDeclaration,
  "provenance" | "provenanceAsOf"
> &
  Partial<
    Pick<ParsedIncomeDeclaration, "nature" | "amountBasis" | "assumedContributionThrough">
  >;

/** A validated income write — `holdingId` is added by the action that knows it. */
export type ParsedIncome = ParsedPayoutSchedule & ParsedIncomeDeclaration;

export type IncomeDeclarationResult =
  | { ok: true; declaration: IncomeDeclarationPatch }
  | { ok: false; error: string };

export type IncomeResult =
  | { ok: true; income: ParsedIncome }
  | { ok: false; error: string };

/** The field names the form posts, in the order they are lifted. */
export const INCOME_FORM_FIELDS = [
  "label",
  "amount",
  "cadence",
  "startISO",
  "endISO",
  "expenses",
  "leaseRegime",
  "rentRevision",
  "rentRevisionReference",
  "postMandatoryTermPolicy",
  ...DECLARATION_FIELDS,
] as const satisfies ReadonlyArray<keyof IncomeFields>;

/**
 * Lift a NEW declaration off its FormData; an absent field is `""`. A new income
 * has nothing to preserve, so a field the form did not carry is simply undeclared.
 */
export function incomeFieldsFromForm(formData: FormData): IncomeFields {
  const entries = INCOME_FORM_FIELDS.map((name) => {
    const raw = formData.get(name);
    return [name, typeof raw === "string" ? raw : ""] as const;
  });
  return Object.fromEntries(entries) as unknown as IncomeFields;
}

/**
 * Lift a CORRECTION off its FormData: only the fields the form carried. Absent
 * means «not sent, leave it as it is»; `""` means «Sin declarar» was chosen.
 */
export function incomeDeclarationFieldsFromForm(
  formData: FormData,
): Partial<IncomeDeclarationFields> {
  const present = DECLARATION_FIELDS.flatMap((name) => {
    const raw = formData.get(name);
    return typeof raw === "string" ? [[name, raw] as const] : [];
  });
  return Object.fromEntries(present);
}

/** An income's stored declaration as the form's field values — the prefill. */
export function declarationValuesOf(
  income: Pick<Income, keyof IncomeDeclarationFields>,
): IncomeDeclarationFields {
  return {
    nature: income.nature ?? "",
    amountBasis: income.amountBasis ?? "",
    provenance: income.provenance ?? "",
    provenanceAsOf: income.provenanceAsOf ?? "",
    assumedContributionThrough: income.assumedContributionThrough ?? "",
  };
}

function choiceOf<T extends string>(
  raw: string,
  choices: ReadonlyArray<{ value: T | Undeclared }>,
): { ok: true; value: T | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const match = choices.find((choice) => choice.value === trimmed);
  return match ? { ok: true, value: match.value as T } : { ok: false };
}

const PROVENANCE_REQUIRED =
  "Indica de dónde sale la cifra: una simulación oficial o una estimación tuya.";

/**
 * Parse the declaration proper: nature, basis, provenance + cut-off, condition.
 * `todayISO` bounds the cut-off — the data a figure comes from cannot be dated
 * after the day it is declared. A choice ABSENT from `fields` stays absent from
 * the result (see {@link IncomeDeclarationPatch}); the provenance and its cut-off
 * are required whether sent or not.
 */
export function parseIncomeDeclaration(
  fields: Partial<IncomeDeclarationFields>,
  todayISO: string,
): IncomeDeclarationResult {
  const nature =
    fields.nature === undefined
      ? undefined
      : choiceOf(fields.nature, INCOME_NATURE_CHOICES);
  if (nature && !nature.ok) {
    return { ok: false, error: "Elige una naturaleza válida para la renta." };
  }
  const amountBasis =
    fields.amountBasis === undefined
      ? undefined
      : choiceOf(fields.amountBasis, INCOME_AMOUNT_BASIS_CHOICES);
  if (amountBasis && !amountBasis.ok) {
    return {
      ok: false,
      error: "Elige si el importe está en euros de hoy o en euros de cada cobro.",
    };
  }
  const provenance = choiceOf(fields.provenance ?? "", INCOME_PROVENANCE_CHOICES);
  if (!provenance.ok || provenance.value === null) {
    return { ok: false, error: PROVENANCE_REQUIRED };
  }
  const provenanceAsOf = (fields.provenanceAsOf ?? "").trim();
  if (provenanceAsOf === "") {
    return {
      ok: false,
      error:
        "Indica la fecha de corte de la cifra: el día al que corresponden los datos de los que sale.",
    };
  }
  if (!isValidISODate(provenanceAsOf)) {
    return { ok: false, error: "Introduce una fecha de corte válida." };
  }
  if (provenanceAsOf > todayISO) {
    return { ok: false, error: "La fecha de corte no puede ser posterior a hoy." };
  }
  const condition = fields.assumedContributionThrough?.trim();
  if (condition && !isValidISODate(condition)) {
    return {
      ok: false,
      error: "Introduce una fecha válida para la cotización que supone la cifra.",
    };
  }
  return {
    ok: true,
    declaration: {
      provenance: provenance.value,
      provenanceAsOf,
      ...(nature?.ok ? { nature: nature.value } : {}),
      ...(amountBasis?.ok ? { amountBasis: amountBasis.value } : {}),
      ...(condition === undefined
        ? {}
        : { assumedContributionThrough: condition || null }),
    },
  };
}

/**
 * Parse + validate a whole income declaration: the recurrence the ficha always
 * parsed (label, amount, cadence, window, costs, lease terms — in that order, so
 * the first problem the person meets is the same one as before), then the
 * declaration proper.
 */
export function buildIncomeResult(fields: IncomeFields, todayISO: string): IncomeResult {
  const recurrence = buildPayoutScheduleResult(fields);
  if (!recurrence.ok) return recurrence;
  const parsed = parseIncomeDeclaration(fields, todayISO);
  if (!parsed.ok) return parsed;
  const { declaration } = parsed;
  return {
    ok: true,
    income: {
      ...recurrence.schedule,
      nature: declaration.nature ?? null,
      amountBasis: declaration.amountBasis ?? null,
      provenance: declaration.provenance,
      provenanceAsOf: declaration.provenanceAsOf,
      assumedContributionThrough: declaration.assumedContributionThrough ?? null,
    },
  };
}
