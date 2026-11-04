import { describe, expect, it } from "vitest";

import {
  type ContributionOccurrenceReconciliation,
  type PlannedContribution,
  projectContributionReconciliation,
} from "./contribution-plan";
import { closeContributionPlanOnLink } from "./contribution-plan-link";

const TODAY = "2026-11-04";

function line(overrides: Partial<PlannedContribution> = {}): PlannedContribution {
  return {
    amount: { mode: "money", value: 10_037 },
    cadence: { dayOfMonth: 5, kind: "monthly" },
    destinationHoldingId: "h1",
    id: "c1",
    startDate: "2026-07-05",
    ...overrides,
  };
}

function settled(
  occurrenceId: string,
  state: ContributionOccurrenceReconciliation["state"],
  operationIds: string[] = [],
): ContributionOccurrenceReconciliation {
  return { occurrenceId, operationIds, state };
}

describe("closeContributionPlanOnLink (ADR 0115 decision 5, amending ADR 0041)", () => {
  it("closes a running line today and settles every pending occurrence up to today", () => {
    const closing = closeContributionPlanOnLink({
      contributions: [line()],
      reconciliations: [
        settled("c1:2026-07-05", "fulfilled", ["op1"]),
        settled("c1:2026-08-05", "skipped"),
        // Partial: its execution is a manual operation the link replaces.
        settled("c1:2026-09-05", "open", ["op2"]),
      ],
      today: TODAY,
    });

    expect(closing.close).toEqual([{ endDate: TODAY, id: "c1" }]);
    expect(closing.remove).toEqual([]);
    expect(closing.skip).toEqual([
      { contributionId: "c1", occurrenceId: "c1:2026-09-05", plannedDate: "2026-09-05" },
      { contributionId: "c1", occurrenceId: "c1:2026-10-05", plannedDate: "2026-10-05" },
    ]);
  });

  it("leaves nothing pending once applied: the future is gone and the backlog settled", () => {
    const contributions = [line()];
    const closing = closeContributionPlanOnLink({
      contributions,
      reconciliations: [],
      today: TODAY,
    });
    const closed = contributions.map((contribution) => ({
      ...contribution,
      endDate: closing.close.find((item) => item.id === contribution.id)!.endDate,
    }));
    const projection = projectContributionReconciliation({
      fromDate: "2026-01-01",
      operations: [],
      plan: { contributions: closed, scopeId: "s" },
      reconciliations: closing.skip.map((item) => settled(item.occurrenceId, "skipped")),
      toDate: "2027-12-31",
      today: TODAY,
    });

    expect(projection.pending).toEqual([]);
  });

  it("removes a line that has not started yet: closing it today would end before it starts", () => {
    const closing = closeContributionPlanOnLink({
      contributions: [line({ id: "c2", startDate: "2026-12-05" })],
      reconciliations: [],
      today: TODAY,
    });

    expect(closing).toEqual({ close: [], remove: ["c2"], skip: [] });
  });

  it("keeps a line that already ended before today as it is", () => {
    const closing = closeContributionPlanOnLink({
      contributions: [line({ endDate: "2026-08-31" })],
      reconciliations: [settled("c1:2026-07-05", "fulfilled", ["op1"])],
      today: TODAY,
    });

    expect(closing.close).toEqual([]);
    expect(closing.remove).toEqual([]);
    expect(closing.skip).toEqual([
      { contributionId: "c1", occurrenceId: "c1:2026-08-05", plannedDate: "2026-08-05" },
    ]);
  });

  it("counts today's own occurrence as pending", () => {
    const closing = closeContributionPlanOnLink({
      contributions: [line({ cadence: { dayOfMonth: 4, kind: "monthly" } })],
      reconciliations: [],
      today: TODAY,
    });

    expect(closing.skip.map((item) => item.plannedDate)).toContain(TODAY);
  });
});
