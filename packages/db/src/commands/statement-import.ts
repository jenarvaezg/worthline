import type { StoreContext } from "@db/store-context";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { rippleHistoricalSnapshotsForMixedImport } from "./ripple-engine";
import type { UnitOfWork } from "./types";

/**
 * Statement / mixed-document import dated-fact command (ADR 0055/0059): persist a
 * whole multi-ISIN statement (new + matched funds, optional debt balance histories
 * and property valuations) inside ONE transaction, then run ONE multi-domain
 * ripple so each affected snapshot is reconciled and saved exactly once. Depends
 * only on the shared ripple engine.
 */
export function createStatementImportCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<DatedFactCommandImplementations, "applyStatementImportAndRipple"> {
  return {
    applyStatementImportAndRipple: async ({
      balanceHistories = [],
      funds,
      propertyValuations = [],
      today: todayOpt,
      trigger,
    }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      const operationDateKeysByAsset = new Map<string, string[]>();

      const noteOperationDate = (assetId: string, dateKey: string) => {
        const current = operationDateKeysByAsset.get(assetId) ?? [];
        current.push(dateKey);
        operationDateKeysByAsset.set(assetId, current);
      };

      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger });
        for (const fund of funds) {
          if (fund.kind === "new") {
            await stores.assets.createInvestmentAsset(fund.asset);
          }
        }

        for (const fund of funds) {
          const assetId = fund.kind === "new" ? fund.asset.id : fund.assetId;
          for (const input of fund.creates) {
            await stores.operations.recordOperation(input, { batchId });
            noteOperationDate(assetId, input.executedAt.slice(0, 10));
          }

          if (fund.kind === "matched") {
            for (const input of fund.overwrites) {
              const result = await stores.operations.updateOperation(input);
              if (result) noteOperationDate(assetId, result.executedAt.slice(0, 10));
            }
            for (const operationId of fund.deletes ?? []) {
              const result = await stores.operations.deleteOperation(operationId);
              if (result) noteOperationDate(assetId, result.executedAt.slice(0, 10));
            }
          }
        }

        for (const history of balanceHistories) {
          for (const rebaseline of history.rebaselines) {
            await stores.liabilities.addBalanceRebaseline(rebaseline, { batchId });
          }
        }
        for (const valuation of propertyValuations) {
          await stores.assets.addValuationAnchor(valuation, { batchId });
        }

        const workspace = await ctx.getWorkspace();
        if (!workspace) return;

        // ONE multi-domain ripple for the whole import. Every affected holding
        // is folded in memory and each snapshot is reconciled/saved once.
        await rippleHistoricalSnapshotsForMixedImport(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            debts: balanceHistories
              .filter(({ rebaselines }) => rebaselines.length > 0)
              .map(({ liabilityId, rebaselines }) => ({
                fromDateKey: rebaselines.reduce(
                  (min, item) => (item.baselineDate < min ? item.baselineDate : min),
                  rebaselines[0]!.baselineDate,
                ),
                liabilityId,
              })),
            housing: propertyValuations.map(({ assetId, valuationDate }) => ({
              assetId,
              fromDateKey: valuationDate,
            })),
            investments: [...operationDateKeysByAsset].map(([assetId, dateKeys]) => ({
              assetId,
              dateKeys,
            })),
            today,
          },
        );
      });
    },
  };
}
