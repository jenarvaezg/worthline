/**
 * The alta's non-blocking acquisition-date question (#1561, child of #1437).
 *
 * The acquisition date is not a label: it decides from WHEN the housing exists
 * in the histórico (`historical-snapshot.ts` only carries the asset from its
 * first market appraisal onwards). And the simple wizard's inmueble drawer does
 * not even ask for it — it stamps TODAY. So a piso bought in 2004 enters the
 * book as if it had been bought this morning, and the mortgage that financed it
 * — whose own curve DOES reach back to 2004 — vanishes from every graph dated
 * before today (#1436, the Plasencia case).
 *
 * This module is the one contradiction worthline can see by itself: an
 * acquisition dated today sitting next to a debt whose history already starts
 * earlier. It asks; it never rejects. Only the user knows the real date, and a
 * flat bought genuinely today next to an old car loan is perfectly legitimate.
 *
 * Pure and framework-agnostic like the rest of the intake seam: the caller
 * reads the debt start dates from the workspace and hands them in.
 */

import { formatDateKeyEs, isDateKeyShaped } from "@worthline/domain";

/** What the notice carries: the oldest debt start the acquisition amputates. */
export interface AcquisitionTodayNotice {
  earliestDebtStart: string;
}

/**
 * The question itself, in the present tense, so EVERY surface that can ask it
 * asks the same thing: the alta's success band and the assistant's proposal card
 * (which asks before writing). Each surface appends its own way out — the band
 * points at the ficha's editor, the card at descartar — but the reason why the
 * date matters is written here, once.
 *
 * A missing start date (a hand-crafted URL) still asks the useful half rather
 * than printing whatever the query string carried.
 */
export function acquisitionTodayQuestion(earliestDebtStart: string | undefined): string {
  const debtPart =
    earliestDebtStart !== undefined && isDateKeyShaped(earliestDebtStart)
      ? `una deuda que arranca el ${formatDateKeyEs(earliestDebtStart)}`
      : "una deuda anterior";

  return `La fecha de adquisición es hoy, pero ya tienes ${debtPart}. Si el inmueble se compró antes, su histórico no llegará hacia atrás y esa deuda quedará fuera de las gráficas de entonces. ¿Es correcta la fecha?`;
}

/**
 * The one gate, written once: is the acquisition stamped on the day it is being
 * typed? A type predicate so the caller that passes the check also gets the date
 * narrowed — the rule and the narrowing can never drift apart.
 */
function isDatedToday(
  acquisitionDate: string | undefined,
  today: string,
): acquisitionDate is string {
  return acquisitionDate !== undefined && acquisitionDate === today;
}

/**
 * Is this alta worth reading the workspace for? The gate is public so the caller
 * can skip the debt read entirely on a historical acquisition — and so that the
 * rule deciding it is the very same one the notice applies.
 */
export function acquisitionDatedToday(input: {
  acquisitionDate: string | undefined;
  today: string;
}): boolean {
  return isDatedToday(input.acquisitionDate, input.today);
}

/**
 * The notice, or null when there is nothing to ask: the acquisition is
 * historical (the user already said when), or no debt starts before it (nothing
 * gets amputated).
 *
 * `debtStarts` are the earliest dates the debts' own curves reach — ISO date
 * keys, so plain string comparison orders them.
 */
export function acquisitionTodayNotice(input: {
  acquisitionDate: string | undefined;
  debtStarts: readonly string[];
  today: string;
}): AcquisitionTodayNotice | null {
  const { acquisitionDate, today } = input;

  if (!isDatedToday(acquisitionDate, today)) {
    return null;
  }

  let earliest: string | undefined;

  for (const start of input.debtStarts) {
    if (start >= acquisitionDate) {
      continue;
    }

    if (earliest === undefined || start < earliest) {
      earliest = start;
    }
  }

  return earliest === undefined ? null : { earliestDebtStart: earliest };
}
