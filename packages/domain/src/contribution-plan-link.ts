/**
 * What linking a holding to a source that owns it does to its contribution plan
 * (ADR 0115 decision 5, amending ADR 0041; #1881). A linked holding has no plan in
 * worthline: its past is the source's data and its future is already declared at the
 * source. So, on linking:
 *
 * - each running line closes TODAY (its `endDate`), so no occurrence after today is
 *   ever derived again;
 * - a line that has not started yet is removed: closing it today would end it before
 *   it starts, which the plan refuses;
 * - every occurrence up to today still pending — never reconciled, or open with
 *   executions that were the manual operations the link replaces — is settled as
 *   `skipped`, the one closed state that keeps no execution truth. Occurrences are
 *   derived, not stored, so settling them is how they leave the pending list.
 *
 * Pure: the careo previews it and the command applies it, from the same function.
 */

import {
  type ContributionOccurrenceReconciliation,
  expandPlannedContribution,
  type PlannedContribution,
} from "./contribution-plan";

export interface ContributionPlanLinkClosing {
  /** Lines that run past today: they end today. */
  close: { id: string; endDate: string }[];
  /** Lines that start after today: they go. */
  remove: string[];
  /** Occurrences up to today still pending: settled as skipped. */
  skip: { contributionId: string; occurrenceId: string; plannedDate: string }[];
}

const CLOSED_STATES = new Set<ContributionOccurrenceReconciliation["state"]>([
  "fulfilled",
  "skipped",
]);

export function closeContributionPlanOnLink(input: {
  contributions: readonly PlannedContribution[];
  reconciliations: readonly ContributionOccurrenceReconciliation[];
  today: string;
}): ContributionPlanLinkClosing {
  const closedOccurrences = new Set(
    input.reconciliations
      .filter((item) => CLOSED_STATES.has(item.state))
      .map((item) => item.occurrenceId),
  );
  const closing: ContributionPlanLinkClosing = { close: [], remove: [], skip: [] };

  for (const contribution of input.contributions) {
    if (contribution.startDate > input.today) {
      closing.remove.push(contribution.id);
      continue;
    }
    if (contribution.endDate === undefined || contribution.endDate > input.today) {
      closing.close.push({ endDate: input.today, id: contribution.id });
    }
    for (const occurrence of expandPlannedContribution(
      contribution,
      contribution.startDate,
      input.today,
    )) {
      if (closedOccurrences.has(occurrence.id)) continue;
      closing.skip.push({
        contributionId: contribution.id,
        occurrenceId: occurrence.id,
        plannedDate: occurrence.plannedDate,
      });
    }
  }
  return closing;
}
