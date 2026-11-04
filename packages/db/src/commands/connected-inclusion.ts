import type { CreateInvestmentAssetInput } from "@db/asset-store";
import { chunk } from "@db/chunk";
import { readAppliedFactKeys } from "@db/connected-source-owning-store";
import {
  assets,
  connectedSourceLinks,
  connectedSources,
  connectorAppliedFacts,
} from "@db/schema";
import type { StoreContext } from "@db/store-context";
import type {
  CreateInvestmentOperationInput,
  CreateManualAssetInput,
  NormalizedBatch,
} from "@worthline/domain";
import { isMirroredSourceAdapter, reconcileFacts } from "@worthline/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { commitReconciled } from "./connector-commit";
import {
  rippleHistoricalSnapshotsForOperations,
  throwCommandResultError,
} from "./ripple-engine";
import type { UnitOfWork } from "./types";

/** One holding an owning source creates for a product it found (#1880). */
export interface ConnectedHoldingCreation {
  /** The product's strong identifier at the source (ADR 0115, #1869 P3). */
  productKey: string;
  holding:
    | { kind: "investment"; asset: CreateInvestmentAssetInput }
    /** A cash account: a stored balance, with no movements (#1869 P4). */
    | { kind: "cash"; asset: CreateManualAssetInput };
}

/**
 * Including products of a source that OWNS its holdings (#1880, ADR 0115): the
 * holdings to create and the operations that give them their history, as the
 * ingestion port carries them — each operation a fact with its dedup key.
 */
export interface IncludeConnectedHoldingsCommand {
  sourceId: string;
  today: string;
  holdings: readonly ConnectedHoldingCreation[];
  /** The operations, keyed for the dedup ledger; the cursor is where the port resumes. */
  facts: NormalizedBatch<CreateInvestmentOperationInput>;
}

export interface IncludeConnectedHoldingsResult {
  created: number;
  applied: number;
}

const LEDGER_ROWS_PER_INSERT = 100;

/**
 * The first start of an owning source, and every later «Incluir con su histórico»
 * (#1880, ADR 0115 decision 1): its holdings and their whole history land in ONE
 * `fact_batch`, ONE transaction and ONE ripple (ADR 0062), through the ingestion
 * port's commit (ADR 0066) — the facts are reconciled against the source's dedup
 * ledger, and the ledger and the cursor advance with them.
 *
 * What it refuses, by throwing inside the transaction so nothing lands:
 * - a source that does not exist or mirrors instead of owning;
 * - a product that is already linked (a second include of the same product would
 *   create its twin);
 * - an operation for a holding this source does not own (the store's source writer).
 */
export function createConnectedInclusionCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<DatedFactCommandImplementations, "includeConnectedHoldingsAndRipple"> {
  return {
    includeConnectedHoldingsAndRipple: async (command) => {
      const { sourceId, today } = command;
      const workspace = await ctx.getWorkspace();
      if (!workspace) throw new Error("Workspace must be initialized before including.");

      const source = await ctx.db
        .select({
          adapter: connectedSources.adapter,
          cursor: connectedSources.ingestCursor,
        })
        .from(connectedSources)
        .where(eq(connectedSources.id, sourceId))
        .get();
      if (!source || isMirroredSourceAdapter(source.adapter)) {
        throw new Error(`Connected source "${sourceId}" does not own holdings.`);
      }

      const plan = reconcileFacts(
        command.facts,
        await readAppliedFactKeys(ctx, sourceId),
      );
      const dateKeysByAsset = new Map<string, string[]>();

      const result = await commitReconciled<CreateInvestmentOperationInput>({
        connectedSourceId: sourceId,
        plan,
        today,
        trigger: "connect",
        uow,
        persistFacts: async (facts, batchId) => {
          await createLinkedHoldings(ctx, stores, sourceId, command.holdings);
          const operations = facts.map((fact) => fact.payload);
          await stores.operations.recordSourceOperations(sourceId, operations, {
            batchId,
          });
          for (const fact of facts) {
            const keys = dateKeysByAsset.get(fact.payload.assetId) ?? [];
            keys.push(fact.dateKey);
            dateKeysByAsset.set(fact.payload.assetId, keys);
          }
          return facts.map((fact) => fact.dateKey);
        },
        recordCommit: async ({ appliedKeys, batchId, cursor }) => {
          for (const keys of chunk(appliedKeys, LEDGER_ROWS_PER_INSERT)) {
            await ctx.db
              .insert(connectorAppliedFacts)
              .values(keys.map((factKey) => ({ batchId, factKey, sourceId })))
              .run();
          }
          // The cursor only moves forward: including a product later, from an older
          // read, must not send the next sync back over days it already covered.
          if (cursor !== null && (source.cursor === null || cursor > source.cursor)) {
            await ctx.db
              .update(connectedSources)
              .set({ ingestCursor: cursor, updatedAt: sql`CURRENT_TIMESTAMP` })
              .where(eq(connectedSources.id, sourceId))
              .run();
          }
        },
        // ONE ripple over every holding the batch touched (#1435): the floor the
        // batch computed is the earliest of these dates.
        ripple: async () => {
          await rippleHistoricalSnapshotsForOperations(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              assets: [...dateKeysByAsset].map(([assetId, operationDateKeys]) => ({
                assetId,
                operationDateKeys,
              })),
              today,
            },
          );
        },
      });

      if (!result.ok) throwCommandResultError(result);
      return { applied: result.value.applied, created: command.holdings.length };
    },
  };
}

/**
 * Create the holdings and link each to its product, refusing a product that is
 * already linked. Each holding is born linked (`connected_source_id`), so from its
 * first row only the source can write its operations.
 */
async function createLinkedHoldings(
  ctx: StoreContext,
  stores: DatedFactStores,
  sourceId: string,
  holdings: readonly ConnectedHoldingCreation[],
): Promise<void> {
  if (holdings.length === 0) return;

  const productKeys = holdings.map((entry) => entry.productKey);
  if (new Set(productKeys).size !== productKeys.length) {
    throw new Error("The same product cannot be included twice in one batch.");
  }
  const linked = await ctx.db
    .select({ productKey: connectedSourceLinks.productKey })
    .from(connectedSourceLinks)
    .where(
      and(
        eq(connectedSourceLinks.sourceId, sourceId),
        inArray(connectedSourceLinks.productKey, productKeys),
      ),
    )
    .all();
  if (linked.length > 0) {
    throw new Error(`Product "${linked[0]!.productKey}" is already linked to a holding.`);
  }

  for (const { holding } of holdings) {
    if (holding.kind === "investment") {
      await stores.assets.createInvestmentAsset(holding.asset);
    } else {
      await stores.assets.createManualAsset(holding.asset);
    }
  }
  const assetIds = holdings.map(({ holding }) => holding.asset.id);
  await ctx.db
    .update(assets)
    .set({ connectedSourceId: sourceId, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(inArray(assets.id, assetIds))
    .run();
  await ctx.db
    .insert(connectedSourceLinks)
    .values(
      holdings.map(({ holding, productKey }) => ({
        assetId: holding.asset.id,
        productKey,
        sourceId,
      })),
    )
    .run();
}
