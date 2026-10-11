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
import type { Income } from "@worthline/domain";
import {
  deriveScheduleOccurrences,
  incomeExclusionReason,
  passiveIncomeTrailing,
} from "@worthline/domain";
import {
  INCOME_AMOUNT_BASIS_CHOICES,
  INCOME_NATURE_CHOICES,
  INCOME_PROVENANCE_CHOICES,
} from "./income-form";
import { PAYOUT_CADENCE_LABELS } from "./income-recurrence";

/** Whether an income is counting, and the sentence that says so (or why not). */
export interface IncomeCountingStatus {
  counts: boolean;
  /** The word mark beside it — colour is never the only signal (design-system §8). */
  mark: "Cuenta" | "Contará" | "No cuenta";
  text: string;
}

/** The window the passive-income figures read: the trailing 12 months (#658). */
const PASSIVE_WINDOW_MONTHS = 12;

/**
 * The counting status, in the order a person can fix things: a missing or
 * excluding declaration first (ADR 0108's reasons, the same copy every figure
 * prints when it withholds the income), then the asset — missing, or in the
 * Papelera — and only then the calendar.
 *
 * An income without an asset is read by one figure only: the sustainable spending
 * (#1674, ADR 0111) — in its income half while in force, as its dated line before it
 * starts. The passive-income figures sum a holding's payouts and never see it, so
 * its sentence names that card — the retirement plan's, on Objetivos — and nothing
 * else. A future one's condition is checked against the declared retirement there,
 * on the card that knows it; here it is named as the rule, so the list never
 * promises what the card withholds.
 *
 * The calendar is read the way the figure reads it (#1673 review): the renta
 * pasiva sums the payouts of the trailing 12 months (`passiveIncomeTrailing`), so
 * an income that ended years ago, or whose every recent occurrence was excluded,
 * contributes nothing there and says so — the occurrences come from the same
 * `deriveScheduleOccurrences` the figure uses, never a re-derivation.
 */
export function incomeCountingStatus(
  income: Income,
  todayISO: string,
  {
    holdingInTrash = false,
  }: {
    /** The linked holding sits in the Papelera: no figure reads a trashed holding. */
    holdingInTrash?: boolean;
  } = {},
): IncomeCountingStatus {
  const reason = incomeExclusionReason(income);
  if (reason !== null) {
    return { counts: false, mark: "No cuenta", text: INCOME_EXCLUSION_COPY[reason] };
  }
  if (income.holdingId === null) {
    return standaloneCountingStatus(income, todayISO);
  }
  if (holdingInTrash) {
    return {
      counts: false,
      mark: "No cuenta",
      text: "Su activo está en la Papelera: mientras siga allí, sus cobros no suman en ninguna cifra.",
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
  const inWindow =
    passiveIncomeTrailing(
      deriveScheduleOccurrences(income, todayISO),
      todayISO,
      PASSIVE_WINDOW_MONTHS,
    ).count > 0;
  const ended = income.endISO !== null && income.endISO < todayISO;
  if (ended) {
    const end = formatDay(income.endISO!);
    return inWindow
      ? {
          counts: true,
          mark: "Cuenta",
          text: `Terminó el ${end}: sus cobros hasta esa fecha aún suman en la renta pasiva de los últimos 12 meses.`,
        }
      : {
          counts: false,
          mark: "No cuenta",
          text: `Terminó el ${end}: ya no le queda ningún cobro en la renta pasiva de los últimos 12 meses.`,
        };
  }
  return inWindow
    ? {
        counts: true,
        mark: "Cuenta",
        text: "Cuenta como renta pasiva: sus cobros de los últimos 12 meses suman en la renta pasiva de su activo.",
      }
    : {
        counts: false,
        mark: "No cuenta",
        text: "Ningún cobro suyo cae en los últimos 12 meses: ahora mismo no suma en la renta pasiva.",
      };
}

/** An income no asset generates: the sustainable spending is the figure that reads it. */
function standaloneCountingStatus(
  income: Income,
  todayISO: string,
): IncomeCountingStatus {
  if (income.endISO !== null && income.endISO < todayISO) {
    return {
      counts: false,
      mark: "No cuenta",
      text: `Terminó el ${formatDay(income.endISO)}: ya no suma en el gasto sostenible.`,
    };
  }
  if (income.startISO <= todayISO) {
    // Ya llega: su condición, si la declaró, dejó de ser una suposición.
    return {
      counts: true,
      mark: "Cuenta",
      text: "Cuenta en el gasto sostenible de tu plan de jubilación, en Objetivos: suma a lo que ya te llega cada mes.",
    };
  }
  const condition =
    income.assumedContributionThrough === null
      ? ""
      : " Si declaras jubilarte antes de lo que supone cotizar, sale de la tarjeta.";
  return {
    counts: true,
    mark: "Contará",
    text: `Contará en el gasto sostenible de tu plan de jubilación desde el ${formatDay(income.startISO)}, como una línea con fecha que no se suma a lo de hoy.${condition}`,
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
