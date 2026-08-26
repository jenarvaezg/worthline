import type { DebtHistoryFloor } from "@web/intake";
import type { WorthlineStore } from "@web/store";

/**
 * Read the earliest date every live debt's own curve reaches (#1561) — the fact
 * the alta's acquisition-date question compares against.
 *
 * The floor of an amortizable debt is its disbursement date: the devengo, the
 * date the money existed, never the first payment (ADR 0019). A debt entered as
 * «estado actual» (ADR 0056) carries a disbursement date that is really its
 * re-baseline day, plus the true firma as `originalSigningDate` when the user
 * declared it; the older of the two is what the user means by "cuándo empezó",
 * so that is the floor.
 *
 * A debt with no amortization plan (revolving, informal, or simply unmodelled)
 * declares no start date at all — its curve is flat from today's balance — so it
 * cannot predate anything and is left out entirely rather than floored at some
 * invented date. Trashed debts never reach here: `readLiabilities` excludes them.
 */
export async function readDebtHistoryFloors(
  store: WorthlineStore,
): Promise<DebtHistoryFloor[]> {
  const liabilities = await store.liabilities.readLiabilities();
  const plans = await Promise.all(
    liabilities.map((liability) => store.liabilities.readAmortizationPlan(liability.id)),
  );

  return plans.flatMap((plan, index) => {
    if (!plan) {
      return [];
    }

    const signing = plan.originalSigningDate;

    return [
      {
        liabilityId: liabilities[index]!.id,
        startDate:
          signing !== null && signing < plan.disbursementDate
            ? signing
            : plan.disbursementDate,
      },
    ];
  });
}
