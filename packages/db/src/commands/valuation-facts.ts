import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import { applyDatedFactsBatch } from "./apply-dated-facts-batch";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import {
  rippleHistoricalSnapshotsForValuation,
  rippleHousingAfterEdit,
  throwCommandResultError,
} from "./ripple-engine";
import type { UnitOfWork } from "./types";

/**
 * The earliest dateKey strictly before `today` of an existing snapshot that
 * carries this asset's row, or null. Used by the fully-behind-seam housing
 * methods to find the earliest snapshot a curve change could affect —
 * including ones dated before the first anchor (rate compounds backward, #184).
 */
async function housingEarliestSnapshotDate(
  snapshots: SnapshotStore,
  assetId: string,
  today: string,
): Promise<string | null> {
  const rows = await snapshots.readSnapshotHoldings({
    holdingId: assetId,
    kind: "asset",
  });
  return (
    rows
      .map((row) => row.dateKey)
      .filter((dateKey) => dateKey < today)
      .sort()[0] ?? null
  );
}

/**
 * Housing / valuation dated-fact commands (PRD #108, ADR 0020): declare, edit, or
 * delete valuation anchors, change the appreciation rate / cadence, record a
 * current value, create a housing holding, and the ripple-only editAsset seam.
 * Depends only on the shared ripple engine.
 */
export function createValuationCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<
  DatedFactCommandImplementations,
  | "addValuationAnchorAndRipple"
  | "updateValuationAnchorAndRipple"
  | "deleteValuationAnchorAndRipple"
  | "setAnnualAppreciationRateAndRipple"
  | "setHousingValuationCadenceAndRipple"
  | "recordHousingValuationAndRipple"
  | "createHousingHoldingAndRipple"
  | "rippleHousingAfterAssetEdit"
> {
  return {
    addValuationAnchorAndRipple: async (input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      const result = await applyDatedFactsBatch(uow, {
        batch: { trigger: "manual" },
        ripple: async (fromDateKey) => {
          const workspace = await ctx.getWorkspace();
          if (!workspace) return;
          await rippleHistoricalSnapshotsForValuation(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            { assetId: input.assetId, fromDateKey, today },
          );
        },
        steps: [
          {
            persist: async (batchId) => {
              await stores.assets.addValuationAnchor(input, { batchId });
              return input.valuationDate;
            },
          },
        ],
        today,
      });
      if (!result.ok) throwCommandResultError(result);
    },
    updateValuationAnchorAndRipple: (anchorId, input, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The new date may differ from the old
      // one; ripple from the earlier of the two so every affected snapshot is
      // recomputed. The previous row is read behind the seam before the patch.
      return ctx.transaction(async () => {
        const previous = await stores.assets.readValuationAnchorById(anchorId);
        const changes = await stores.assets.updateValuationAnchor(anchorId, input);
        if (changes === 0 || !previous) return changes;
        const assetId = previous.assetId;
        const newDate = input.valuationDate ?? previous.valuationDate;
        const fromDateKey =
          previous.valuationDate < newDate ? previous.valuationDate : newDate;
        if (fromDateKey <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForValuation(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              { assetId, fromDateKey, today },
            );
          }
        }
        return changes;
      });
    },
    deleteValuationAnchorAndRipple: (anchorId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic delete + ripple (ADR 0020). The asset id and from-date come from the
      // deleted row itself, captured before the delete; a future date generates no
      // history and a not-found delete ripples nothing.
      return ctx.transaction(async () => {
        const removed = await stores.assets.readValuationAnchorById(anchorId);
        const changes = await stores.assets.deleteValuationAnchor(anchorId);
        if (changes === 0 || !removed) return changes;
        if (removed.valuationDate <= today) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForValuation(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              { assetId: removed.assetId, fromDateKey: removed.valuationDate, today },
            );
          }
        }
        return changes;
      });
    },
    setAnnualAppreciationRateAndRipple: async (assetId, rate, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020). The earliest affected snapshot date is
      // derived behind the seam: min(first anchor date, earliest existing snapshot
      // carrying this asset) — covers the backward-compounding case (#184).
      await ctx.transaction(async () => {
        await stores.assets.setAnnualAppreciationRate(assetId, rate);
        const firstAnchorDate = (await stores.assets.readValuationAnchors(assetId))[0]
          ?.valuationDate;
        const earliestSnapshotDate = await housingEarliestSnapshotDate(
          stores.snapshots,
          assetId,
          today,
        );
        const fromDateKey =
          [firstAnchorDate, earliestSnapshotDate]
            .filter((d): d is string => d != null)
            .sort()[0] ?? null;
        if (fromDateKey === null || fromDateKey > today) return;
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForValuation(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            assetId,
            fromDateKey,
            today,
          },
        );
      });
    },
    setHousingValuationCadenceAndRipple: async (assetId, cadence, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Atomic persist + ripple (ADR 0020 / 0031): a cadence change is a parameter
      // edit (ADR 0012), so the whole appreciation curve is recut. The from-date is
      // derived behind the seam (first past anchor / earliest snapshot) by the
      // shared housing-edit ripple — guarded against an empty range or a future
      // from-date inside it. Mirrors setAnnualAppreciationRateAndRipple.
      await ctx.transaction(async () => {
        await stores.assets.setValuationCadence(assetId, cadence);
        await rippleHousingAfterEdit(
          ctx,
          { assets: stores.assets, snapshots: stores.snapshots },
          assetId,
          today,
        );
      });
    },
    recordHousingValuationAndRipple: async (assetId, currentValue, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Full persist + upsert-today-anchor + ripple, all atomic (ADR 0020).
      // The from-date is min(first past anchor, earliest snapshot) — same rule as
      // firstHousingCurrentValueRippleDate in the old action layer.
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        await stores.assets.updateAssetValuation(assetId, currentValue);
        // Upsert a today-dated market anchor (adjustsPriorCurve: true).
        const existing = (await stores.assets.readValuationAnchors(assetId)).find(
          (a) => a.valuationDate === today,
        );
        if (existing) {
          await stores.assets.updateValuationAnchor(existing.id, {
            adjustsPriorCurve: true,
            valueMinor: currentValue,
          });
        } else {
          await stores.assets.addValuationAnchor(
            {
              adjustsPriorCurve: true,
              assetId,
              id: ctx.newId(),
              valuationDate: today,
              valueMinor: currentValue,
            },
            { batchId },
          );
        }
        // Derive from-date: first anchor through today, else earliest snapshot (see #184).
        const firstAnchorDate = (await stores.assets.readValuationAnchors(assetId))
          .map((a) => a.valuationDate)
          .filter((d) => d <= today)
          .sort()[0];
        const fromDateKey =
          firstAnchorDate ??
          (await housingEarliestSnapshotDate(stores.snapshots, assetId, today));
        if (fromDateKey === null || fromDateKey > today) return;
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForValuation(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            assetId,
            fromDateKey,
            today,
          },
        );
      });
    },
    createHousingHoldingAndRipple: async (command, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the create + anchor/rate seeding + ripple commit or
      // roll back together (ADR 0020). The from-date is the acquisition date,
      // derived behind the seam from the command's own acquisition anchor.
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        await stores.assets.createManualAsset(command.asset);
        await stores.assets.addValuationAnchor(command.acquisitionAnchor, { batchId });
        await stores.assets.setAnnualAppreciationRate(
          command.asset.id,
          command.annualAppreciationRate,
        );
        if (command.initialValuation) {
          await stores.assets.addValuationAnchor(command.initialValuation, { batchId });
        }
        const workspace = await ctx.getWorkspace();
        if (!workspace) return;
        await rippleHistoricalSnapshotsForValuation(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            assetId: command.asset.id,
            fromDateKey: command.acquisitionAnchor.valuationDate,
            today,
          },
        );
      });
    },
    rippleHousingAfterAssetEdit: async (assetId, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // Ripple-only seam for editAsset (ADR 0020): no dated fact persisted here.
      await ctx.transaction(async () => {
        await rippleHousingAfterEdit(
          ctx,
          { assets: stores.assets, snapshots: stores.snapshots },
          assetId,
          today,
        );
      });
    },
  };
}
