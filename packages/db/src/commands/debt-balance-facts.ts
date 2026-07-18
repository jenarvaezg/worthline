import { liabilityBalanceRebaselines } from "@db/schema";
import type { StoreContext } from "@db/store-context";
import type { DebtModel, Workspace } from "@worthline/domain";
import { eq } from "drizzle-orm";
import { applyDatedFactsBatch } from "./apply-dated-facts-batch";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import {
  rippleHistoricalSnapshotsForDebt,
  throwCommandResultError,
} from "./ripple-engine";
import type { UnitOfWork } from "./types";

/**
 * Re-cut a debt's whole modeled curve under a given model (#1051). Dispatches
 * the ripple by the model's own primitive: amortizable from its plan (every past
 * cuota boundary) or, planless, from its earliest re-baseline; revolving/informal
 * from their earliest balance anchor. A model with no defining fact yet has no
 * curve to cut — the flip stands and the balance falls back until a declaration
 * (a re-baseline or an anchor) gives the new model a curve.
 */
async function rippleWholeDebtCurveByModel(
  ctx: StoreContext,
  stores: DatedFactStores,
  workspace: Workspace,
  params: { debtModel: DebtModel; liabilityId: string; today: string },
): Promise<void> {
  const { debtModel, liabilityId, today } = params;
  const save = stores.snapshots.saveSnapshot;
  if (debtModel === "amortizable") {
    const plan = await stores.liabilities.readAmortizationPlan(liabilityId);
    if (plan) {
      await rippleHistoricalSnapshotsForDebt(ctx, workspace, save, {
        kind: "amortizable-plan",
        liabilityId,
        today,
      });
      return;
    }
    const rebaselines = await stores.liabilities.readBalanceRebaselines(liabilityId);
    const earliestBaseline = rebaselines.map((r) => r.baselineDate).sort()[0];
    if (earliestBaseline !== undefined) {
      await rippleHistoricalSnapshotsForDebt(ctx, workspace, save, {
        fromDateKey: earliestBaseline,
        kind: "amortizable-rebaseline",
        liabilityId,
        today,
      });
    }
    return;
  }
  const anchors = await stores.liabilities.readBalanceAnchors(liabilityId);
  const earliestAnchor = anchors.map((a) => a.anchorDate).sort()[0];
  if (earliestAnchor !== undefined && earliestAnchor <= today) {
    await rippleHistoricalSnapshotsForDebt(ctx, workspace, save, {
      fromDateKey: earliestAnchor,
      kind: "anchor",
      liabilityId,
      today,
    });
  }
}

/**
 * Debt-balance dated-fact commands (ADR 0056, PRD #109): balance re-baselines and
 * anchors, current-state debt entry, balance-history import, the valuation cadence
 * flag, and the debt-model flip — each with ONE ripple. Depends only on the shared
 * ripple engine.
 */
export function createDebtBalanceCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<
  DatedFactCommandImplementations,
  | "createCurrentStateDebtAndRipple"
  | "importBalanceHistoryAndRipple"
  | "addBalanceRebaselineAndRipple"
  | "updateBalanceRebaselineAndRipple"
  | "deleteBalanceRebaselineAndRipple"
  | "addBalanceAnchorAndRipple"
  | "updateBalanceAnchorAndRipple"
  | "deleteBalanceAnchorAndRipple"
  | "setValuationCadenceAndRipple"
  | "changeDebtModelAndRipple"
> {
  return {
    setValuationCadenceAndRipple: async (liabilityId, cadence, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      await ctx.transaction(async () => {
        await stores.liabilities.setValuationCadence(liabilityId, cadence);
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        // A cadence change recuts the whole modeled curve (a parameter edit, ADR
        // 0012). Re-ripple the affected debt by its model: amortizable from its
        // plan (every past cuota boundary), revolving from its earliest anchor.
        // Informal (always a step) and a model with no anchors have no between-event
        // movement the cadence could change, so they need no ripple.
        const debtModel = await stores.liabilities.readDebtModel(liabilityId);
        if (debtModel === "amortizable") {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            { kind: "amortizable-plan", liabilityId, today },
          );
        } else if (debtModel === "revolving") {
          const anchors = await stores.liabilities.readBalanceAnchors(liabilityId);
          const earliestAnchorDate = anchors.map((a) => a.anchorDate).sort()[0];
          if (earliestAnchorDate !== undefined && earliestAnchorDate <= today) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              { fromDateKey: earliestAnchorDate, kind: "anchor", liabilityId, today },
            );
          }
        }
      });
    },
    changeDebtModelAndRipple: async (liabilityId, debtModel, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      await ctx.transaction(async () => {
        const previous = await stores.liabilities.readDebtModel(liabilityId);
        if (previous === debtModel) return; // a no-op flip ripples nothing
        await stores.liabilities.setDebtModel(liabilityId, debtModel);
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        // Re-cut the whole modeled curve under the NEW model. Like a cadence
        // change, the flag change recuts every snapshot the new model can reach;
        // the pre-change past it cannot reach stays frozen (ADR 0012/0056).
        await rippleWholeDebtCurveByModel(ctx, stores, workspace, {
          debtModel,
          liabilityId,
          today,
        });
      });
    },
    createCurrentStateDebtAndRipple: async ({ plan, rebaseline, today: todayOpt }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction: the plan row, the rebaseline fact, the balance sync,
      // and the single ripple commit or roll back together (ADR 0020 / 0056).
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        await stores.liabilities.createAmortizationPlan(plan);
        await stores.liabilities.addBalanceRebaseline(rebaseline, { batchId });
        await stores.liabilities.updateLiabilityBalance(
          rebaseline.liabilityId,
          rebaseline.outstandingBalanceMinor,
        );
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        // The rebaseline (with startsAtBaseline) governs the curve from here
        // forward regardless of the plan row's own dates — one ripple suffices.
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            fromDateKey: rebaseline.baselineDate,
            kind: "amortizable-rebaseline",
            liabilityId: rebaseline.liabilityId,
            today,
          },
        );
      });
    },
    importBalanceHistoryAndRipple: async ({
      liabilityId,
      rebaselines,
      today: todayOpt,
    }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        for (const rebaseline of rebaselines) {
          await stores.liabilities.addBalanceRebaseline(rebaseline, { batchId });
        }
        if (rebaselines.length === 0) return;
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        const fromDateKey = rebaselines.reduce(
          (earliest, rebaseline) =>
            rebaseline.baselineDate < earliest ? rebaseline.baselineDate : earliest,
          rebaselines[0]!.baselineDate,
        );
        await rippleHistoricalSnapshotsForDebt(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            fromDateKey,
            kind: "amortizable-rebaseline",
            liabilityId,
            today,
          },
        );
      });
      return rebaselines.length;
    },
    addBalanceRebaselineAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      const result = await applyDatedFactsBatch(uow, {
        batch: { trigger: "manual" },
        ripple: async (fromDateKey) => {
          const workspace = await ctx.getWorkspace();
          if (!workspace) return;
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              fromDateKey,
              kind: "amortizable-rebaseline",
              liabilityId: input.liabilityId,
              today,
            },
          );
        },
        steps: [
          {
            persist: async (batchId) => {
              await stores.liabilities.addBalanceRebaseline(input, { batchId });
              return input.baselineDate;
            },
          },
        ],
        today,
      });
      if (!result.ok) throwCommandResultError(result);
    },
    updateBalanceRebaselineAndRipple: (rebaselineId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        const {
          baselineDate: previousBaselineDate,
          changes,
          liabilityId,
        } = await stores.liabilities.updateBalanceRebaseline(rebaselineId, input);
        if (
          changes === 0 ||
          previousBaselineDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        const newDate = input.baselineDate ?? previousBaselineDate;
        const fromDateKey =
          previousBaselineDate < newDate ? previousBaselineDate : newDate;
        if (fromDateKey <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey,
                kind: "amortizable-rebaseline",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    deleteBalanceRebaselineAndRipple: (rebaselineId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        // Guard the degenerate case (#676 review): a re-baseline is sometimes the
        // ONLY dated fact defining an amortizable debt's curve (ADR 0056
        // current-state entry — no plan row at all). Deleting the sole survivor
        // would leave debtBalanceAtDate with neither a plan nor a rebaseline to
        // derive from, silently flattening the curve to currentBalanceMinor
        // forever instead of failing loud — mirrors the "no amortization plan"
        // guard in amortizableBalanceAtDateFor. Refuse before anything is deleted.
        const target = await ctx.db
          .select({ liabilityId: liabilityBalanceRebaselines.liabilityId })
          .from(liabilityBalanceRebaselines)
          .where(eq(liabilityBalanceRebaselines.id, rebaselineId))
          .get();
        if (target) {
          const [plan, siblings] = await Promise.all([
            stores.liabilities.readAmortizationPlan(target.liabilityId),
            stores.liabilities.readBalanceRebaselines(target.liabilityId),
          ]);
          if (!plan && siblings.length === 1) {
            throw new Error(
              `Liability "${target.liabilityId}" has no amortization plan; deleting its only balance re-baseline would leave the debt with no curve.`,
            );
          }
        }

        const {
          baselineDate: previousBaselineDate,
          changes,
          liabilityId,
        } = await stores.liabilities.deleteBalanceRebaseline(rebaselineId);
        if (
          changes === 0 ||
          previousBaselineDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        if (previousBaselineDate <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            // "amortizable-revision": generate nothing, only recalculate the
            // existing snapshots forward from fromDateKey — a lost rebaseline
            // never mints new payment-boundary dates.
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey: previousBaselineDate,
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
    addBalanceAnchorAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      const result = await applyDatedFactsBatch(uow, {
        batch: { trigger: "manual" },
        ripple: async (fromDateKey) => {
          const workspace = await ctx.getWorkspace();
          if (!workspace) return;
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              fromDateKey,
              kind: "anchor",
              liabilityId: input.liabilityId,
              today,
            },
          );
        },
        steps: [
          {
            persist: async (batchId) => {
              await stores.liabilities.addBalanceAnchor(input, { batchId });
              return input.anchorDate;
            },
          },
        ],
        today,
      });
      if (!result.ok) throwCommandResultError(result);
    },
    updateBalanceAnchorAndRipple: (anchorId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        // The seam reads the OLD date + owning liability from the row by id inside
        // the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          anchorDate: previousAnchorDate,
          liabilityId,
        } = await stores.liabilities.updateBalanceAnchor(anchorId, input);
        if (
          changes === 0 ||
          previousAnchorDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        const newDate = input.anchorDate ?? previousAnchorDate;
        // From-date math unchanged: the earlier of the old/new date.
        const fromDateKey = previousAnchorDate < newDate ? previousAnchorDate : newDate;
        if (fromDateKey <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey,
                kind: "anchor",
                liabilityId,
                today,
              },
            );
          }
        }
        return changes;
      });
    },
    deleteBalanceAnchorAndRipple: (anchorId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        // The seam reads the removed date + owning liability from the row by id
        // inside the transaction (ADR 0025): the caller no longer pre-reads them.
        const {
          changes,
          anchorDate: previousAnchorDate,
          liabilityId,
        } = await stores.liabilities.deleteBalanceAnchor(anchorId);
        if (
          changes === 0 ||
          previousAnchorDate === undefined ||
          liabilityId === undefined
        )
          return 0;
        // From-date unchanged: the removed anchor's own date.
        if (previousAnchorDate <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForDebt(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                fromDateKey: previousAnchorDate,
                kind: "anchor",
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
