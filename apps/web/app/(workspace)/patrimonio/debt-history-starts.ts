import type { WorthlineStore } from "@web/store";

/**
 * Read the earliest date every live debt's own curve reaches (#1561) — the fact
 * the alta's acquisition-date question compares against.
 *
 * The start of an amortizable debt is its disbursement date: the devengo, the
 * date the money existed, never the first payment (ADR 0019). A debt entered as
 * «estado actual» (ADR 0056) carries a disbursement date that is really its
 * re-baseline day, plus the true firma as `originalSigningDate` when the user
 * declared it; the older of the two is what the user means by "cuándo empezó",
 * so that is the start.
 *
 * A debt with no amortization plan (revolving, informal, or simply unmodelled)
 * declares no start date at all — its curve is flat from today's balance — so it
 * cannot predate anything and is left out entirely rather than floored at some
 * invented date. Trashed debts never reach here: `readLiabilities` excludes them.
 *
 * One plan read per debt, and no bulk reader behind it on purpose: the alta this
 * rides on already ripples the property's whole history, hundreds of writes, so
 * a handful of parallel point reads buys nothing measurable.
 */
export async function readDebtHistoryStarts(
  store: Pick<WorthlineStore, "liabilities">,
): Promise<string[]> {
  const liabilities = await store.liabilities.readLiabilities();
  const plans = await Promise.all(
    liabilities.map((liability) => store.liabilities.readAmortizationPlan(liability.id)),
  );

  return plans.flatMap((plan) => {
    if (!plan) {
      return [];
    }

    const signing = plan.originalSigningDate;

    return [
      signing !== null && signing < plan.disbursementDate
        ? signing
        : plan.disbursementDate,
    ];
  });
}
