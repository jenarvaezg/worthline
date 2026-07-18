import type { StoreContext } from "@db/store-context";
import { applyDatedFactsBatch } from "./apply-dated-facts-batch";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import {
  rippleHistoricalSnapshots,
  rippleHistoricalSnapshotsForOperations,
  throwCommandResultError,
} from "./ripple-engine";
import type { UnitOfWork } from "./types";

/**
 * Investment-operation dated-fact commands (ADR 0020/0062): record/merge/delete
 * one or many operations and ripple the historical snapshots they touch, plus
 * the contribution-plan linkage seams. Depends only on the shared ripple engine.
 */
export function createInvestmentOperationCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<
  DatedFactCommandImplementations,
  | "createAndLinkContributionOperation"
  | "applyStoredContributionValue"
  | "recordOperationAndRipple"
  | "recordOperationsAndRipple"
  | "deleteOperationAndRipple"
  | "deleteOperationsAndRipple"
> {
  return {
    createAndLinkContributionOperation: async (params) => {
      const today = params.today ?? new Date().toISOString().slice(0, 10);
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        await stores.operations.recordOperation(params.operation, { batchId });
        const workspace = await ctx.getWorkspace();
        if (workspace) {
          await rippleHistoricalSnapshots(ctx, workspace, stores.snapshots.saveSnapshot, {
            assetId: params.operation.assetId,
            mode: "record",
            operationDateKey: params.operation.executedAt.slice(0, 10),
            today,
          });
        }
        await stores.contributionPlan.linkOperation({
          contributionId: params.contributionId,
          occurrenceId: params.occurrenceId,
          operationId: params.operation.id,
        });
      });
    },
    applyStoredContributionValue: async (params) => {
      await ctx.transaction(async () => {
        await stores.contributionPlan.assertStoredDestination(
          params.contributionId,
          params.assetId,
        );
        await stores.operations.batchApplyValueUpdates([
          { id: params.assetId, newValueMinor: params.newValueMinor },
        ]);
        await stores.contributionPlan.setOccurrenceState({
          contributionId: params.contributionId,
          occurrenceId: params.occurrenceId,
          state: "fulfilled",
          storedExecutionMinor: params.executedMinor,
        });
      });
    },
    recordOperationAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      const result = await applyDatedFactsBatch(uow, {
        batch: { trigger: "manual" },
        ripple: async (operationDateKey) => {
          const workspace = await ctx.getWorkspace();
          if (!workspace) return;
          await rippleHistoricalSnapshots(ctx, workspace, stores.snapshots.saveSnapshot, {
            assetId: input.assetId,
            mode: "record",
            operationDateKey,
            today,
          });
        },
        steps: [
          {
            persist: async (batchId) => {
              await stores.operations.recordOperation(input, { batchId });
              return input.executedAt.slice(0, 10);
            },
          },
        ],
        today,
      });
      if (!result.ok) throwCommandResultError(result);
    },
    recordOperationsAndRipple: async ({
      assetId,
      creates,
      deletes = [],
      overwrites,
      today: todayOpt,
    }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction so every create/overwrite + the single batched ripple
      // commit or roll back together (ADR 0020 / 0018). The affected from-date
      // window is derived here from the persisted operations, never by the caller.
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        const operationDateKeys: string[] = [];
        for (const input of creates) {
          await stores.operations.recordOperation(input, { batchId });
          operationDateKeys.push(input.executedAt.slice(0, 10));
        }
        for (const input of overwrites) {
          const result = await stores.operations.updateOperation(input);
          if (result) operationDateKeys.push(result.executedAt.slice(0, 10));
        }
        for (const operationId of deletes) {
          const result = await stores.operations.deleteOperation(operationId);
          if (result) operationDateKeys.push(result.executedAt.slice(0, 10));
        }
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForOperations(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          { assets: [{ assetId, operationDateKeys }], today },
        );
      });
    },
    deleteOperationAndRipple: ({ operationId, today: todayOpt }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction so the delete + ripple commit or roll back together
      // (ADR 0020). The asset id and from-date come from the deleted row itself;
      // a not-found delete ripples nothing.
      return ctx.transaction(async () => {
        const result = await stores.operations.deleteOperation(operationId);
        if (!result) return null;
        const workspace = await ctx.getWorkspace();
        if (workspace) {
          await rippleHistoricalSnapshots(ctx, workspace, stores.snapshots.saveSnapshot, {
            assetId: result.assetId,
            mode: "delete",
            operationDateKey: result.executedAt.slice(0, 10),
            today,
          });
        }
        return result;
      });
    },
    deleteOperationsAndRipple: ({ operationIds, today: todayOpt }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      return ctx.transaction(async () => {
        const deleted: Array<{ assetId: string; executedAt: string }> = [];
        const operationDateKeysByAsset = new Map<string, string[]>();

        for (const operationId of operationIds) {
          const result = await stores.operations.deleteOperation(operationId);
          if (!result) continue;
          deleted.push(result);
          const dateKey = result.executedAt.slice(0, 10);
          const current = operationDateKeysByAsset.get(result.assetId) ?? [];
          current.push(dateKey);
          operationDateKeysByAsset.set(result.assetId, current);
        }

        if (deleted.length === 0) return [];
        const workspace = await ctx.getWorkspace();
        if (workspace) {
          await rippleHistoricalSnapshotsForOperations(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              assets: [...operationDateKeysByAsset].map(
                ([assetId, operationDateKeys]) => ({
                  assetId,
                  operationDateKeys,
                }),
              ),
              mode: "delete",
              today,
            },
          );
        }

        return deleted;
      });
    },
  };
}
