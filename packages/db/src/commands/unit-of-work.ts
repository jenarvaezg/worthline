import { factBatches } from "@db/schema";
import type { StoreContext } from "@db/store-context";
import type { UnitOfWork } from "./types";

/** Wrap the store's transaction seam as a command-layer UnitOfWork. */
export function createUnitOfWork(ctx: StoreContext): UnitOfWork {
  return {
    createFactBatch: async (input) => {
      const id = ctx.newId();
      await ctx.db
        .insert(factBatches)
        .values({
          id,
          trigger: input.trigger,
          connectedSourceId: input.connectedSourceId ?? null,
          syncRunId: null,
        })
        .run();
      return id;
    },
    transaction: (work) => ctx.transaction(work),
  };
}
