import type { StoreContext } from "@db/store-context";
import type { UnitOfWork } from "./types";

/** Wrap the store's transaction seam as a command-layer UnitOfWork. */
export function createUnitOfWork(ctx: StoreContext): UnitOfWork {
  return {
    transaction: (work) => ctx.transaction(work),
  };
}
