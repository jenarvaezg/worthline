/**
 * What a declared income says about itself (#1673, ADR 0108). Pure: no React.
 *
 * Shared by the Rentas list and the holding's ficha, so the two can never tell the
 * same income two different stories. The one sentence that matters most is the
 * counting status: an income that does not enter a figure has to say WHICH reason
 * keeps it out, because every one of those reasons is something the person can
 * act on — declare the nature, declare the basis — or at least must not mistake
 * for a working figure.
 */

import { INCOME_EXCLUSION_COPY } from "@web/income-exclusion-copy";
import { formatDay } from "@web/objetivos/format-day";
import { PAYOUT_CADENCE_LABELS } from "@web/patrimonio/[id]/editar/_surfaces/cobros-form";
import type { Income } from "@worthline/domain";
import { incomeExclusionReason } from "@worthline/domain";
import {
  INCOME_AMOUNT_BASIS_CHOICES,
  INCOME_NATURE_CHOICES,
  INCOME_PROVENANCE_CHOICES,
} from "./income-form";

/** Whether an income is counting, and the sentence that says so (or why not). */
export interface IncomeCountingStatus {
  counts: boolean;
  /** The word mark beside it — colour is never the only signal (design-system §8). */
  mark: "Cuenta" | "Contará" | "No cuenta";
  text: string;
}

/**
 * The counting status, in the order a person can fix things: a missing or
 * excluding declaration first (ADR 0108's reasons, the same copy every figure
 * prints when it withholds the income), and only then the missing asset.
 *
 * An income without an asset is the honest odd one out: no figure reads it yet —
 * the passive-income figures sum a holding's payouts, and the dated card that will
 * consume standalone income is S3 of #1522. Saying «cuenta» there would be the
 * very lie this declaration exists to stop.
 */
export function incomeCountingStatus(
  income: Pick<Income, "nature" | "amountBasis" | "holdingId" | "startISO">,
  todayISO: string,
): IncomeCountingStatus {
  const reason = incomeExclusionReason(income);
  if (reason !== null) {
    return { counts: false, mark: "No cuenta", text: INCOME_EXCLUSION_COPY[reason] };
  }
  if (income.holdingId === null) {
    return {
      counts: false,
      mark: "No cuenta",
      text: "Sin activo enlazado: todavía ninguna cifra lee las rentas sin activo, así que de momento no cuenta.",
    };
  }
  // A future start is preserved verbatim and derives nothing until it arrives
  // (ADR 0054 point 4) — counting, but not yet.
  if (income.startISO > todayISO) {
    return {
      counts: true,
      mark: "Contará",
      text: `Contará como renta pasiva desde el ${formatDay(income.startISO)}; hasta entonces no suma ningún cobro.`,
    };
  }
  return {
    counts: true,
    mark: "Cuenta",
    text: "Cuenta como renta pasiva: sus cobros hasta hoy suman en la renta pasiva de su activo.",
  };
}

const NATURE_LABEL = new Map<string, string>(
  INCOME_NATURE_CHOICES.map(({ value, label }) => [value, label]),
);
const BASIS_LABEL = new Map<string, string>(
  INCOME_AMOUNT_BASIS_CHOICES.map(({ value, label }) => [value, label.toLowerCase()]),
);
const PROVENANCE_LABEL = new Map<string, string>(
  INCOME_PROVENANCE_CHOICES.map(({ value, label }) => [value, label]),
);

/** «Pasiva · importe en euros de hoy» — or «sin declarar», never a blank. */
export function incomeDeclarationLine(income: Pick<Income, "nature" | "amountBasis">) {
  const nature =
    income.nature === null
      ? "Naturaleza sin declarar"
      : (NATURE_LABEL.get(income.nature) ?? income.nature);
  const basis =
    income.amountBasis === null
      ? "importe sin declarar"
      : `importe en ${BASIS_LABEL.get(income.amountBasis) ?? income.amountBasis}`;
  return `${nature} · ${basis}`;
}

/**
 * «Simulación oficial, con datos a 18 ago 2026». An income declared before the
 * door required it (every migrated one) says it has none instead of inventing one.
 */
export function incomeProvenanceLine(
  income: Pick<Income, "provenance" | "provenanceAsOf">,
): string {
  if (income.provenance === null) return "Procedencia sin declarar";
  const source = PROVENANCE_LABEL.get(income.provenance) ?? income.provenance;
  return income.provenanceAsOf === null
    ? `${source}, sin fecha de corte`
    : `${source}, con datos a ${formatDay(income.provenanceAsOf)}`;
}

const CADENCE_LABEL = new Map<string, string>(
  PAYOUT_CADENCE_LABELS.map(({ cadence, label }) => [cadence, label]),
);

/** «Mensual · desde 1 nov 2030», or both ends of a closed window. */
export function incomeWindowLine(
  income: Pick<Income, "cadence" | "startISO" | "endISO">,
): string {
  const cadence = CADENCE_LABEL.get(income.cadence) ?? income.cadence;
  const window = income.endISO
    ? `${formatDay(income.startISO)} – ${formatDay(income.endISO)}`
    : `desde ${formatDay(income.startISO)}`;
  return `${cadence} · ${window}`;
}

/**
 * The Rentas list's order:the incomes no ficha shows first — they have nowhere
 * else to be seen — then by start date and concept, so an optimistic row lands
 * where the stored one will be and nothing jumps when the server answers.
 */
export function sortIncomesForDisplay<
  T extends Pick<Income, "holdingId" | "startISO" | "label" | "id">,
>(incomes: readonly T[]): T[] {
  return [...incomes].sort(
    (a, b) =>
      Number(a.holdingId !== null) - Number(b.holdingId !== null) ||
      a.startISO.localeCompare(b.startISO) ||
      a.label.localeCompare(b.label, "es") ||
      a.id.localeCompare(b.id),
  );
}

/** The condition the figure rests on, when one was declared. */
export function incomeConditionLine(
  income: Pick<Income, "assumedContributionThrough">,
): string | null {
  return income.assumedContributionThrough === null
    ? null
    : `Supone seguir cotizando hasta el ${formatDay(income.assumedContributionThrough)}`;
}
