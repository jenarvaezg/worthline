import type { LiabilityStore } from "@db/liability-store";
import type { StoreContext } from "@db/store-context";
import { eventBoundaryDate } from "@worthline/domain";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { debtPlanBand, rippleHistoricalSnapshotsForDebt } from "./debt-band";
import { recalcOnlyBand } from "./ripple-band";

/**
 * The from-date a ripple for an amortization-plan event (early repayment or rate
 * revision) must RECALCULATE from (#1042): the schedule boundary the event anchors
 * to, NOT its raw date. The live curve buckets an event by the boundary it falls in
 * (#182), and both event types reshape that whole cycle — the lump changes its
 * interest and recomputed cuota, a revision its payment — so under `interpolated`
 * every date in the cycle is redrawn and the boundary is the earliest one that can
 * move. Rippling from the raw date would leave those in-window snapshots diverging
 * from the live curve forever, and a later ripple crossing the window would
 * silently rewrite figures the user already saw.
 *
 * It is NOT where a repayment's own snapshot is generated: the curve steps down on
 * the repayment date (#1291), so that date is the dated fact's generate-at date
 * (ADR 0012) and travels as the band's `eventDates`, separate from its
 * `recalcFrom`. Under the default `step` cadence the recalculated in-window
 * snapshots simply land back on the value they already held.
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
  | "importAmortizationScheduleAndRipple"
> {
  return {
    importAmortizationScheduleAndRipple: async ({
      liabilityId,
      revisions,
      earlyRepayments,
      today,
    }) => {
      const written = revisions.length + earlyRepayments.length;
      // One transaction, ONE ripple (ADR 0020). Twenty-three events applied one
      // at a time would be twenty-three ripples over the same thirty years, and
      // a failure in the middle would leave half a mortgage's history rewritten.
      return ctx.transaction(async () => {
        await stores.liabilities.addInterestRateRevisions(revisions);
        await stores.liabilities.addEarlyRepayments(earlyRepayments);
        if (written === 0) return 0;

        const workspace = await ctx.getWorkspace();
        if (!workspace) return written;
        // The whole-plan band, not a per-event one: a batch read off a cuadro
        // reshapes the schedule from its earliest event, and only the plan band
        // both regenerates the cuota series and recalculates the whole curve.
        // Recalculating a date whose figure does not move is a no-op.
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          { band: debtPlanBand, liabilityId, today },
        );
        return written;
      });
    },
    createAmortizationPlanAndRipple: async (input, opts) => {
      const today = opts.today;
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
            band: debtPlanBand,
            liabilityId: input.liabilityId,
            today,
          },
        );
      });
    },
    updateAmortizationPlanAndRipple: (planId, input, opts) => {
      const today = opts.today;
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
              band: debtPlanBand,
              liabilityId: opts.liabilityId,
              today,
            },
          );
        }
        return changes;
      });
    },
    deleteAmortizationPlanAndRipple: (opts) => {
      const today = opts.today;
      // Capture the disbursement date BEFORE deleting — the earliest date the debt
      // existed (ADR 0019), the recalc floor for the now-planless curve. An empty
      // `eventDates` recalculates without generating, so the curve falls back to
      // currentBalance (`debtPlanBand` resolves to null with no plan row and
      // cannot be used here). The liability owns exactly one plan (1:1), so it is
      // resolved from the liability id.
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
                // A lost plan mints no new payment-boundary date.
                band: recalcOnlyBand(startDate),
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
      const today = opts.today;
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
            // A revision mints no date of its own; it redraws the cycle it
            // lands in, from that cuota boundary forward.
            band: recalcOnlyBand(
              await amortizationEventRippleFromDate(
                stores.liabilities,
                opts.liabilityId,
                input.revisionDate,
              ),
            ),
            liabilityId: opts.liabilityId,
            today,
          },
        );
      });
    },
    updateInterestRateRevisionAndRipple: (revisionId, input, opts) => {
      const today = opts.today;
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
                band: recalcOnlyBand(
                  await amortizationEventRippleFromDate(
                    stores.liabilities,
                    liabilityId,
                    rawFromDateKey,
                  ),
                ),
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
      const today = opts.today;
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
                band: recalcOnlyBand(
                  await amortizationEventRippleFromDate(
                    stores.liabilities,
                    liabilityId,
                    previousRevisionDate,
                  ),
                ),
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
      const today = opts.today;
      // A past repayment is a dated fact: generate the snapshot at its own date —
      // where the curve steps (#1291) — and recalculate from its cuota boundary
      // forward. The band carries both dates.
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
            band: {
              // The curve steps on the repayment's own date (#1291) — the
              // history needs a point THERE — while the recalculation starts at
              // the cuota boundary the lump lands in (#1042).
              eventDates: [input.repaymentDate],
              recalcFrom: await amortizationEventRippleFromDate(
                stores.liabilities,
                opts.liabilityId,
                input.repaymentDate,
              ),
            },
            liabilityId: opts.liabilityId,
            today,
          },
        );
      });
    },
    updateEarlyRepaymentAndRipple: (repaymentId, input, opts) => {
      const today = opts.today;
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
                band: {
                  // The snapshot is generated where the curve steps NOW (#1291):
                  // the new date. The old one keeps its snapshot and is
                  // recalculated, since the recalc floor is the boundary of the
                  // earlier of the two dates.
                  eventDates: [newDate],
                  recalcFrom: await amortizationEventRippleFromDate(
                    stores.liabilities,
                    liabilityId,
                    rawFromDateKey,
                  ),
                },
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
      const today = opts.today;
      // Deleting a dated fact recalculates from its date forward without
      // generating: the curve no longer carries it, so it mints no date.
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
                // The curve no longer carries the repayment: nothing to mint,
                // recalculate from the boundary it used to reshape.
                band: recalcOnlyBand(
                  await amortizationEventRippleFromDate(
                    stores.liabilities,
                    liabilityId,
                    previousRepaymentDate,
                  ),
                ),
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
