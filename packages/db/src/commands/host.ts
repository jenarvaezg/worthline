import { rippleHistoricalSnapshotsForDebt } from "@db/dated-fact-seams";
import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";

import type { UnitOfWork } from "./types";
import { createUnitOfWork } from "./unit-of-work";

/**
 * Command-layer infrastructure built once per store lifetime (#966). Gives typed
 * command executors a UnitOfWork and ripple hooks without reaching into store
 * slices or dated-fact composite seams.
 */
export interface CommandHost {
  uow: UnitOfWork;
  rippleDebtRebaseline: (params: {
    liabilityId: string;
    fromDateKey: string;
    today: string;
  }) => Promise<void>;
}

export function createCommandHost(
  ctx: StoreContext,
  snapshots: { saveSnapshot: SnapshotStore["saveSnapshot"] },
): CommandHost {
  return {
    rippleDebtRebaseline: async ({ liabilityId, fromDateKey, today }) => {
      const workspace = await ctx.getWorkspace();
      if (!workspace) return;
      await rippleHistoricalSnapshotsForDebt(ctx, workspace, snapshots.saveSnapshot, {
        fromDateKey,
        kind: "amortizable-rebaseline",
        liabilityId,
        today,
      });
    },
    uow: createUnitOfWork(ctx),
  };
}
