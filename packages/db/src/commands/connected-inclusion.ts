import type { CreateInvestmentAssetInput } from "@db/asset-store";
import { chunk } from "@db/chunk";
import { readAppliedFactKeys } from "@db/connected-source-owning-store";
import { closeHoldingPlansOnLink } from "@db/contribution-plan-store";
import { readHoldingLedgers, readSplitTransfers } from "@db/holding-ledger-reads";
import {
  assetOperations,
  assets,
  connectedSourceLinks,
  connectedSources,
  connectorAppliedFacts,
  factBatchReplacedOperations,
  investmentAssets,
} from "@db/schema";
import type { StoreContext } from "@db/store-context";
import type {
  CreateInvestmentOperationInput,
  CreateManualAssetInput,
  NormalizedBatch,
  SecurityId,
} from "@worthline/domain";
import { isMirroredSourceAdapter, reconcileFacts } from "@worthline/domain";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
 * One holding that already exists BY HAND and becomes the source's (#1881, ADR 0115
 * decisions 5 and 6): the source's operations replace its manual ones.
 */
export interface ConnectedHoldingLink {
  /** The product's strong identifier at the source. */
  productKey: string;
  /** The live manual investment it becomes. */
  assetId: string;
  /**
   * The product's identifier, written onto a holding that carries none (one that
   * was only alike by name): a holding that already has one keeps it.
   */
  securityId?: SecurityId;
}

/**
 * Including products of a source that OWNS its holdings (#1880, ADR 0115): the
 * holdings to create, the manual holdings to link (#1881), and the operations that
 * give them their history, as the ingestion port carries them — each operation a
 * fact with its dedup key, written into the holding it belongs to.
 */
export interface IncludeConnectedHoldingsCommand {
  sourceId: string;
  today: string;
  holdings: readonly ConnectedHoldingCreation[];
  /** Manual holdings that become the source's (#1881); none when absent. */
  links?: readonly ConnectedHoldingLink[];
  /** The operations, keyed for the dedup ledger; the cursor is where the port resumes. */
  facts: NormalizedBatch<CreateInvestmentOperationInput>;
}

export interface IncludeConnectedHoldingsResult {
  created: number;
  /** Manual holdings that became the source's (#1881). */
  linked: number;
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
 * Linking a manual holding (#1881) rides the SAME batch: its manual operations are
 * moved out of the book into `fact_batch_replaced_operations` under this batch's id
 * (the provenance, ADR 0062), its contribution plan closes today (ADR 0115 decision
 * 5), and the ripple's floor reaches the earliest of the replaced and the incoming
 * dates, so every snapshot either side touched is re-derived once.
 *
 * What it refuses, by throwing inside the transaction so nothing lands:
 * - a source that does not exist or mirrors instead of owning;
 * - a product that is already linked, or named twice (a second include of the same
 *   product would create its twin);
 * - a holding to link that is not a live manual investment, or named twice;
 * - a holding with half a traspaso whose other half is not replaced with it;
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
        .select({ adapter: connectedSources.adapter })
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
          const links = command.links ?? [];
          await assertProductsUnlinked(ctx, sourceId, [
            ...command.holdings.map((entry) => entry.productKey),
            ...links.map((link) => link.productKey),
          ]);
          await createLinkedHoldings(ctx, stores, sourceId, command.holdings);
          const replaced = await linkManualHoldings(ctx, {
            batchId,
            links,
            sourceId,
            today,
          });
          for (const [assetId, keys] of replaced) dateKeysByAsset.set(assetId, keys);
          const operations = facts.map((fact) => fact.payload);
          await stores.operations.recordSourceOperations(sourceId, operations, {
            batchId,
          });
          for (const fact of facts) {
            const keys = dateKeysByAsset.get(fact.payload.assetId) ?? [];
            keys.push(fact.dateKey);
            dateKeysByAsset.set(fact.payload.assetId, keys);
          }
          return [...facts.map((fact) => fact.dateKey), ...[...replaced.values()].flat()];
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
          // The comparison is the UPDATE's own condition, inside the transaction:
          // a cursor read before it opened could be overtaken by another include.
          if (cursor !== null) {
            await ctx.db
              .update(connectedSources)
              .set({ ingestCursor: cursor, updatedAt: sql`CURRENT_TIMESTAMP` })
              .where(
                and(
                  eq(connectedSources.id, sourceId),
                  or(
                    isNull(connectedSources.ingestCursor),
                    lt(connectedSources.ingestCursor, cursor),
                  ),
                ),
              )
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
      return {
        applied: result.value.applied,
        created: command.holdings.length,
        linked: command.links?.length ?? 0,
      };
    },
  };
}

/**
 * Refuse a product named twice in one batch, or already linked to a holding: a
 * second include of the same product would create its twin.
 */
async function assertProductsUnlinked(
  ctx: StoreContext,
  sourceId: string,
  productKeys: readonly string[],
): Promise<void> {
  if (productKeys.length === 0) return;
  if (new Set(productKeys).size !== productKeys.length) {
    throw new Error("The same product cannot be included twice in one batch.");
  }
  const linked = await ctx.db
    .select({ productKey: connectedSourceLinks.productKey })
    .from(connectedSourceLinks)
    .where(
      and(
        eq(connectedSourceLinks.sourceId, sourceId),
        inArray(connectedSourceLinks.productKey, [...productKeys]),
      ),
    )
    .all();
  if (linked.length > 0) {
    throw new Error(`Product "${linked[0]!.productKey}" is already linked to a holding.`);
  }
}

/**
 * Create the holdings and link each to its product. Each holding is born linked
 * (`connected_source_id`), so from its first row only the source can write its
 * operations.
 */
async function createLinkedHoldings(
  ctx: StoreContext,
  stores: DatedFactStores,
  sourceId: string,
  holdings: readonly ConnectedHoldingCreation[],
): Promise<void> {
  if (holdings.length === 0) return;

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

/**
 * Make live manual investments the source's (#1881, ADR 0115 decisions 5 and 6),
 * inside the batch: each one's manual operations leave the book for the batch's
 * provenance, its contribution plan closes today, it takes the product's identifier
 * when it had none, and it is linked. Returns, per holding, the days of the
 * operations it lost — they belong in the ripple's floor as much as the new ones.
 */
async function linkManualHoldings(
  ctx: StoreContext,
  input: {
    sourceId: string;
    batchId: string;
    today: string;
    links: readonly ConnectedHoldingLink[];
  },
): Promise<Map<string, string[]>> {
  const replacedDays = new Map<string, string[]>();
  const { links, sourceId } = input;
  if (links.length === 0) return replacedDays;

  const assetIds = links.map((link) => link.assetId);
  if (new Set(assetIds).size !== assetIds.length) {
    throw new Error("The same holding cannot be linked twice in one batch.");
  }
  const rows = await ctx.db
    .select({
      connectedSourceId: assets.connectedSourceId,
      deletedAt: assets.deletedAt,
      id: assets.id,
      type: assets.type,
    })
    .from(assets)
    .where(inArray(assets.id, assetIds))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const assetId of assetIds) {
    const row = byId.get(assetId);
    if (
      !row ||
      row.type !== "investment" ||
      row.connectedSourceId !== null ||
      row.deletedAt !== null
    ) {
      throw new Error(
        `Holding "${assetId}" is not a live manual investment: it cannot be linked.`,
      );
    }
  }

  // A traspaso is removed whole, through the gate that owns both rows (#1393): a
  // half whose other half lives in a holding this batch does not replace would be
  // left behind as a flow nobody made. Linking both holdings at once is fine.
  const split = await readSplitTransfers(ctx, assetIds);
  if (split.length > 0) {
    const { assetId, counterpartAssetId } = split[0]!;
    throw new Error(
      `Holding "${assetId}" has half a traspaso whose other half is in "${counterpartAssetId}": ` +
        "link both at once, or undo the traspaso first.",
    );
  }

  // Every holding's rows in a fixed number of statements, never one read per link.
  const ledgers = await readHoldingLedgers(ctx, assetIds);
  const replaced = [...ledgers].flatMap(([assetId, ledger]) =>
    ledger.operations.map((operation) => ({ assetId, operation })),
  );
  for (const group of chunk(replaced, LEDGER_ROWS_PER_INSERT)) {
    await ctx.db
      .insert(factBatchReplacedOperations)
      .values(
        group.map(({ assetId, operation }) => ({
          assetId,
          batchId: input.batchId,
          operationId: operation.id,
          operationJson: JSON.stringify(operation),
        })),
      )
      .run();
  }
  // An execution that reconciled a plan occurrence goes with its row (FK cascade).
  await ctx.db
    .delete(assetOperations)
    .where(inArray(assetOperations.assetId, assetIds))
    .run();
  for (const { assetId, operation } of replaced) {
    const days = replacedDays.get(assetId) ?? [];
    days.push(operation.executedAt.slice(0, 10));
    replacedDays.set(assetId, days);
  }
  await closeHoldingPlansOnLink(ctx, assetIds, input.today);
  for (const link of links) {
    if (!link.securityId) continue;
    await ctx.db
      .update(investmentAssets)
      .set({ securityId: link.securityId.value, securityIdKind: link.securityId.kind })
      .where(
        and(
          eq(investmentAssets.assetId, link.assetId),
          isNull(investmentAssets.securityId),
        ),
      )
      .run();
  }

  await ctx.db
    .update(assets)
    .set({ connectedSourceId: sourceId, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(inArray(assets.id, assetIds))
    .run();
  await ctx.db
    .insert(connectedSourceLinks)
    .values(
      links.map((link) => ({
        assetId: link.assetId,
        productKey: link.productKey,
        sourceId,
      })),
    )
    .run();
  return replacedDays;
}
