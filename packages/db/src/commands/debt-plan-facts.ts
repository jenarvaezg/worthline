import type { LiabilityStore } from "@db/liability-store";
import type { StoreContext } from "@db/store-context";
import { eventBoundaryDate } from "@worthline/domain";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { rippleHistoricalSnapshotsForDebt } from "./ripple-engine";

/**
 * The from-date a ripple for an amortization-plan event (early repayment or rate
 * revision) must use (#1042): the schedule boundary the event anchors to, NOT its
 * raw date. The live curve buckets an event by the boundary it falls in (#182).
 * For an early repayment the lump lands on that boundary, so the whole window
 * `[boundary, eventDate)` shows the post-lump balance; rippling from the raw date
 * would leave the persisted snapshots in that window at their pre-lump value
 * forever, diverging from the live curve, and a later ripple crossing the window
 * would silently rewrite figures the user already saw. A rate revision does not
 * move the in-window balance (it changes the payment from the next cuota on), so
 * for revisions this alignment is a consistency guarantee, not a divergence fix.
 *
 * Shares the single source of truth (`eventBoundaryDate`) with the curve's own
 * bucketing so the two can never drift. The whether-to-ripple guard (ADR 0012:
 * events dated today/future never generate history) stays on the raw event date
 * upstream; only this from-date moves earlier to the boundary. Falls back to the
 * raw date if the plan is gone (defensive — an amortizable event always has one).
 */
async function amortizationEventRippleFromDate(
  liabilities: LiabilityStore,
  liabilityId: string,
  eventDate: string,
): Promise<string> {
  const plan = await liabilities.readAmortizationPlan(liabilityId);
  return plan ? eventBoundaryDate(plan, eventDate) : eventDate;
}

/**
 * Amortization-plan dated-fact commands (PRD #109, ADR 0019/0025): create, edit,
 * or delete the amortization plan, interest-rate revisions, and early repayments,
 * each with ONE ripple aligned to the affected cuota boundary. Depends only on the
 * shared ripple engine.
 */
export function createDebtPlanCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
): Pick<
  DatedFactCommandImplementations,
  | "createAmortizationPlanAndRipple"
  | "updateAmortizationPlanAndRipple"
  | "deleteAmortizationPlanAndRipple"
  | "addInterestRateRevisionAndRipple"
  | "updateInterestRateRevisionAndRipple"
  | "deleteInterestRateRevisionAndRipple"
  | "addEarlyRepaymentAndRipple"
  | "updateEarlyRepaymentAndRipple"
  | "deleteEarlyRepaymentAndRipple"
> {
  return {
    createAmortizationPlanAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The plan ripple derives its per-cuota
      // date series internally from the plan's own schedule.
      await ctx.transaction(async () => {
        await stores.liabilities.createAmortizationPlan(input);
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            kind: "amortizable-plan",
            liabilityId: input.liabilityId,
            today,
          },
        );
      });
    },
    updateAmortizationPlanAndRipple: (planId, input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        const changes = await stores.liabilities.updateAmortizationPlan(planId, input);
        if (changes === 0) return 0;
        const workspace = await ctx.getWorkspace();
        if (workspace) {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              kind: "amortizable-plan",
              liabilityId: opts.liabilityId,
              today,
            },
          );
        }
        return changes;
      });
    },
    deleteAmortizationPlanAndRipple: (opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      // Capture the disbursement date BEFORE deleting — the earliest date the debt
      // existed (ADR 0019), the recalc floor for the now-planless curve. The
      // "amortizable-revision" kind recalculates without generating, so the curve
      // falls back to currentBalance (the "amortizable-plan" kind early-returns
      // when curve.plan is null and cannot be used here). The liability owns
      // exactly one plan (1:1), so it is resolved from the liability id.
      return ctx.transaction(async () => {
        const plan = await stores.liabilities.readAmortizationPlan(opts.liabilityId);
        if (!plan) return 0;
        const startDate = plan.disbursementDate;
        const changes = await stores.liabilities.deleteAmortizationPlan(plan.id);
        if (changes === 0) return changes;
        if (startDate <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey: startDate,
                kind: "amortizable-revision",
                liabilityId: opts.liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    addInterestRateRevisionAndRipple: async (input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      await ctx.transaction(async () => {
        await stores.liabilities.addInterestRateRevision(input);
        // Guard (ADR 0012) stays on the raw date; the from-date moves to the
        // event's cuota boundary (#1042).
        if (input.revisionDate > today) return;
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            fromDateKey: await amortizationEventRippleFromDate(
              stores.liabilities,
              opts.liabilityId,
              input.revisionDate,
            ),
            kind: "amortizable-revision",
            liabilityId: opts.liabilityId,
            today,
          },
        );
      });
    },
    updateInterestRateRevisionAndRipple: (revisionId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Ripple from the earlier of the old/new date so every affected snapshot
      // recomputes. The seam reads the OLD date itself (ADR 0025).
      return ctx.transaction(async () => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          revisionDate: previousRevisionDate,
          liabilityId,
        } = await stores.liabilities.updateInterestRateRevision(revisionId, input);
        if (
          changes === 0 ||
          previousRevisionDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        const newDate = input.revisionDate ?? previousRevisionDate;
        // Guard (ADR 0012) on the earlier of the old/new RAW date; the from-date
        // then moves to that date's cuota boundary (#1042). Boundary-of-min equals
        // min-of-boundaries (the boundary map is monotonic in the date), so this
        // ripples from the earlier of the old/new BOUNDARY, as required.
        const rawFromDateKey =
          previousRevisionDate < newDate ? previousRevisionDate : newDate;
        if (rawFromDateKey <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey: await amortizationEventRippleFromDate(
                  stores.liabilities,
                  liabilityId,
                  rawFromDateKey,
                ),
                kind: "amortizable-revision",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    deleteInterestRateRevisionAndRipple: (revisionId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          revisionDate: previousRevisionDate,
          liabilityId,
        } = await stores.liabilities.deleteInterestRateRevision(revisionId);
        if (
          changes === 0 ||
          previousRevisionDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // Guard (ADR 0012) on the raw date; the from-date moves to the removed
        // revision's cuota boundary (#1042).
        if (previousRevisionDate <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey: await amortizationEventRippleFromDate(
                  stores.liabilities,
                  liabilityId,
                  previousRevisionDate,
                ),
                kind: "amortizable-revision",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    addEarlyRepaymentAndRipple: async (input, opts) => {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      // A past repayment is a dated fact: generate the snapshot at its date and
      // recalculate the ones after it (the "amortizable-repayment" kind).
      await ctx.transaction(async () => {
        await stores.liabilities.addEarlyRepayment(input);
        // Guard (ADR 0012) stays on the raw date; the from-date moves to the
        // event's cuota boundary (#1042).
        if (input.repaymentDate > today) return;
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            fromDateKey: await amortizationEventRippleFromDate(
              stores.liabilities,
              opts.liabilityId,
              input.repaymentDate,
            ),
            kind: "amortizable-repayment",
            liabilityId: opts.liabilityId,
            today,
          },
        );
      });
    },
    updateEarlyRepaymentAndRipple: (repaymentId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          repaymentDate: previousRepaymentDate,
          liabilityId,
        } = await stores.liabilities.updateEarlyRepayment(repaymentId, input);
        if (
          changes === 0 ||
          previousRepaymentDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        const newDate = input.repaymentDate ?? previousRepaymentDate;
        // Guard (ADR 0012) on the earlier of the old/new RAW date; the from-date
        // then moves to that date's cuota boundary (#1042). Boundary-of-min equals
        // min-of-boundaries (the boundary map is monotonic in the date), so this
        // ripples from the earlier of the old/new BOUNDARY, as required.
        const rawFromDateKey =
          previousRepaymentDate < newDate ? previousRepaymentDate : newDate;
        if (rawFromDateKey <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey: await amortizationEventRippleFromDate(
                  stores.liabilities,
                  liabilityId,
                  rawFromDateKey,
                ),
                kind: "amortizable-repayment",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    deleteEarlyRepaymentAndRipple: (repaymentId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Deleting a dated fact recalculates from its date forward without generating
      // — the "amortizable-revision" kind, since the curve no longer carries it.
      return ctx.transaction(async () => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          repaymentDate: previousRepaymentDate,
          liabilityId,
        } = await stores.liabilities.deleteEarlyRepayment(repaymentId);
        if (
          changes === 0 ||
          previousRepaymentDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // Guard (ADR 0012) on the raw date; the from-date moves to the removed
        // repayment's cuota boundary (#1042).
        if (previousRepaymentDate <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey: await amortizationEventRippleFromDate(
                  stores.liabilities,
                  liabilityId,
                  previousRepaymentDate,
                ),
                kind: "amortizable-revision",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
  };
}
