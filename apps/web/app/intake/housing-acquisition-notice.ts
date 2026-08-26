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
 * reads the debt floors from the workspace and hands them in.
 */

/**
 * The earliest date one debt's own curve reaches. For an amortizable debt that
 * is its disbursement date (the devengo, ADR 0019 — never the first payment),
 * or the declared original signing date when the debt entered as «estado
 * actual» and that firma is older (ADR 0056). A debt with no plan declares no
 * start date at all, so it cannot predate anything and never appears here.
 */
export interface DebtHistoryFloor {
  liabilityId: string;
  startDate: string;
}

/** What the notice carries: the oldest debt start the acquisition amputates. */
export interface AcquisitionTodayNotice {
  earliestDebtStart: string;
}

/**
 * Does this alta stamp the acquisition on the day it is being typed? The gate
 * lives here — and not inlined at the call site — so the rule that decides
 * whether the workspace is worth reading is the same one the notice applies.
 */
export function acquisitionDatedToday(input: {
  acquisitionDate: string | undefined;
  today: string;
}): boolean {
  return input.acquisitionDate !== undefined && input.acquisitionDate === input.today;
}

/**
 * The notice, or null when there is nothing to ask: the acquisition is
 * historical (the user already said when), or no debt starts before it (nothing
 * gets amputated). Dates are ISO date keys, so plain string comparison orders
 * them.
 */
export function acquisitionTodayNotice(input: {
  acquisitionDate: string | undefined;
  debtFloors: readonly DebtHistoryFloor[];
  today: string;
}): AcquisitionTodayNotice | null {
  if (!acquisitionDatedToday(input)) {
    return null;
  }

  const acquisitionDate = input.acquisitionDate!;
  let earliest: string | undefined;

  for (const floor of input.debtFloors) {
    if (floor.startDate >= acquisitionDate) {
      continue;
    }

    if (earliest === undefined || floor.startDate < earliest) {
      earliest = floor.startDate;
    }
  }

  return earliest === undefined ? null : { earliestDebtStart: earliest };
}
