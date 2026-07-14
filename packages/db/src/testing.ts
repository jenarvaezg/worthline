import type { Client } from "@libsql/client";

import type { AssetStore } from "./asset-store";
import {
  createInMemoryStore as createPublicInMemoryStore,
  createStoreFromSqlite as createPublicStoreFromSqlite,
} from "./index";
import type { LiabilityStore } from "./liability-store";
import type { OperationsStore } from "./operations-store";
import type { WorthlineStore } from "./store-types";

/**
 * Explicit escape hatch for persistence-contract tests only. Application code
 * must use the narrowed `WorthlineStore` and its intent-level command surface.
 */
export type PersistenceTestStore = Omit<
  WorthlineStore,
  "assets" | "liabilities" | "operations"
> & {
  assets: AssetStore;
  liabilities: LiabilityStore;
  operations: OperationsStore;
};

export async function createInMemoryStore(): Promise<PersistenceTestStore> {
  return (await createPublicInMemoryStore()) as PersistenceTestStore;
}

export async function createStoreFromSqlite(
  client: Client,
): Promise<PersistenceTestStore> {
  return (await createPublicStoreFromSqlite(client)) as PersistenceTestStore;
}
