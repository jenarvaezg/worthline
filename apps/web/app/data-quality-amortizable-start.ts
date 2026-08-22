/**
 * Fill `amortizableStartByLiabilityId` for the data-quality engine (#1438).
 * Both consumers (home hero and agent-view) already read `debtModelByLiabilityId`;
 * this adds the plan / re-baseline dates those amortizable debts already have,
 * through `amortizableLiabilityStartDate` — the same rule the membership
 * predicate applies. No new category of I/O: the reads ride the mortgage model
 * fetch that already runs.
 */

import type { AgentViewReadStore } from "@worthline/db";
import { amortizableLiabilityStartDate, type DebtModel } from "@worthline/domain";

export async function readAmortizableStartByLiabilityId(
  reads: Pick<AgentViewReadStore, "readAmortizationPlan" | "readBalanceRebaselines">,
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>,
): Promise<Map<string, string>> {
  const amortizableIds = [...debtModelByLiabilityId.entries()]
    .filter(([, model]) => model === "amortizable")
    .map(([id]) => id);
  const entries = await Promise.all(
    amortizableIds.map(async (id) => {
      const [plan, rebaselines] = await Promise.all([
        reads.readAmortizationPlan(id),
        reads.readBalanceRebaselines(id),
      ]);
      const startDate = amortizableLiabilityStartDate({
        balanceRebaselines: rebaselines,
        currentBalanceMinor: 0,
        debtModel: "amortizable",
        ...(plan === null
          ? {}
          : {
              plan: {
                annualInterestRate: plan.annualInterestRate,
                disbursementDate: plan.disbursementDate,
                firstPaymentDate: plan.firstPaymentDate,
                initialCapitalMinor: plan.initialCapitalMinor,
                termMonths: plan.termMonths,
              },
            }),
      });
      return startDate === undefined ? null : ([id, startDate] as const);
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}
