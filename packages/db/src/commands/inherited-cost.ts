import { toOperation } from "@db/operation-reads";
import { assetOperations, assets } from "@db/schema";
import type { StoreContext } from "@db/store-context";
import type {
  InheritedCostRefusal,
  InheritedCostResult,
  InvestmentOperation,
} from "@worthline/domain";
import { answerInheritedCost, confirmTransferOrigin } from "@worthline/domain";
import { isMyInvestorExternalEntry } from "@worthline/pricing";
import { eq } from "drizzle-orm";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { rippleHistoricalSnapshotsForOperations } from "./ripple-engine";
import type { UnitOfWork } from "./types";

/**
 * The answer to a traspaso that came into a linked holding without its cost
 * (#1882, PRD #1876 S7): the cost typed from the old provider's papers, or the
 * reimbursement the user confirmed as its origin.
 */
export type ResolveInheritedCostCommand = {
  /** The holding whose ficha asked: the entry must be one of its rows. */
  assetId: string;
  /** The pending `transfer_in`. */
  entryOperationId: string;
  /** The day the ripple's cut-off is measured against (ADR 0024). */
  today: string;
} & (
  | { kind: "declared"; costMinor: number }
  | {
      kind: "origin";
      /** The unpaired reimbursement (a `sell` marked `unpaired_out`) the user confirmed. */
      originOperationId: string;
    }
);

/** Why the answer was refused: the rule's reasons, or a row that is not there. */
export type ResolveInheritedCostRefusal = InheritedCostRefusal | "not_found";

export type ResolveInheritedCostResult =
  | { ok: true }
  | { ok: false; reason: ResolveInheritedCostRefusal };

/**
 * The ONE write a user makes on a holding its source owns (ADR 0115, decision 4;
 * PRD #1876, invariant 5): the inherited cost of an entry the connector could not
 * know. One lote, one transaction, one ripple (ADR 0062).
 *
 * - **Declared**: the entry's provisional cost is replaced and marked
 *   `cost_declared`. One row, one holding rippled.
 * - **From its origin** (ADR 0115 as amended 2026-11-04): the unpaired reimbursement
 *   becomes the `transfer_out` of the entry, both share the entry's `transferId`,
 *   and the entry inherits what the origin's fold removes (ADR 0082). Both holdings
 *   ripple together, from the earlier of the two days.
 *
 * It UPDATES the rows the connector wrote rather than writing new ones: their ids
 * are the dedup keys of the orders they came from, so a later sync that reads the
 * same orders finds them applied and never rewrites the answer.
 *
 * What it refuses, as data, so the panel says it beside the field: an entry that is
 * not pending (answered in another tab), a cost that is not positive, an origin the
 * rule would not propose (another source's, out of the window, or already used).
 * The rows are read inside the transaction, so two answers cannot both land.
 */
export function createInheritedCostCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<DatedFactCommandImplementations, "resolveInheritedCostAndRipple"> {
  return {
    resolveInheritedCostAndRipple: async (command) => {
      try {
        return await ctx.transaction(async () => {
          const entry = await readRow(ctx, command.entryOperationId);
          if (entry === null || entry.operation.assetId !== command.assetId) {
            throw new Refused("not_found");
          }
          // Only a holding a source owns answers here: a manual one's entry has its
          // own doors (#1518), and no connector ever marks one pending.
          if (entry.sourceId === null) throw new Refused("not_pending");

          const plan =
            command.kind === "declared"
              ? declared(entry.operation, command.costMinor)
              : await fromOrigin(ctx, stores, entry, command.originOperationId);
          if (!plan.ok) throw new Refused(plan.reason);

          const batchId = await uow.createFactBatch({ trigger: "manual" });
          for (const row of plan.value) await rewriteLeg(ctx, row, batchId);

          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForOperations(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                assets: plan.value.map((row) => ({
                  assetId: row.assetId,
                  operationDateKeys: [row.executedAt.slice(0, 10)],
                })),
                today: command.today,
              },
            );
          }
          return { ok: true } as const;
        });
      } catch (error) {
        if (error instanceof Refused) return { ok: false, reason: error.reason };
        throw error;
      }
    },
  };
}

class Refused extends Error {
  constructor(readonly reason: ResolveInheritedCostRefusal) {
    super(`inherited cost refused: ${reason}`);
    this.name = "Refused";
  }
}

interface LedgerRow {
  operation: InvestmentOperation;
  /** The source that owns the row's holding, or null for a manual holding. */
  sourceId: string | null;
  /** Whether the row's holding is in the Papelera. */
  trashed: boolean;
}

async function readRow(ctx: StoreContext, id: string): Promise<LedgerRow | null> {
  const row = await ctx.db
    .select({
      deletedAt: assets.deletedAt,
      operation: assetOperations,
      sourceId: assets.connectedSourceId,
    })
    .from(assetOperations)
    .innerJoin(assets, eq(assets.id, assetOperations.assetId))
    .where(eq(assetOperations.id, id))
    .get();
  if (!row) return null;
  return {
    operation: toOperation(row.operation),
    sourceId: row.sourceId,
    trashed: row.deletedAt !== null,
  };
}

function declared(
  entry: InvestmentOperation,
  costMinor: number,
): InheritedCostResult<InvestmentOperation[]> {
  const answered = answerInheritedCost(entry, costMinor);
  return answered.ok ? { ok: true, value: [answered.value] } : answered;
}

async function fromOrigin(
  ctx: StoreContext,
  stores: DatedFactStores,
  entry: LedgerRow,
  originOperationId: string,
): Promise<InheritedCostResult<InvestmentOperation[]>> {
  // The same three refusals the panel's proposal makes (`inheritedCostView`), so a
  // hand-crafted post cannot pair what the screen would never have offered:
  // - an entry from another institution has its origin outside this book;
  if (isMyInvestorExternalEntry(entry.operation.transferId)) {
    return { ok: false, reason: "not_a_candidate" };
  }
  const origin = await readRow(ctx, originOperationId);
  // - another source's reimbursement, or a manual sale, is never its origin: the
  //   rule pairs legs one source wrote, and only that source's;
  // - nor is one on a holding in the Papelera, which the panel cannot name.
  if (origin === null || origin.sourceId !== entry.sourceId || origin.trashed) {
    return { ok: false, reason: "not_a_candidate" };
  }
  const confirmed = confirmTransferOrigin({
    entry: entry.operation,
    origin: origin.operation,
    originLedger: await stores.operations.readOperations(origin.operation.assetId),
  });
  return confirmed.ok
    ? { ok: true, value: [confirmed.value.out, confirmed.value.incoming] }
    : confirmed;
}

/**
 * Rewrite one leg in place: its kind, its traspaso columns and its mark. Units,
 * price, date, id and `batch_id` are the order's and never move — they are what the
 * source stated, the id is its dedup key, and the batch is the one that brought it
 * (ADR 0062). The answer's own batch is recorded in the audit trail beside it.
 */
async function rewriteLeg(
  ctx: StoreContext,
  operation: InvestmentOperation,
  batchId: string,
): Promise<void> {
  await ctx.db
    .update(assetOperations)
    .set({
      kind: operation.kind,
      transferCostMinor: operation.transferCostMinor ?? null,
      transferId: operation.transferId ?? null,
      transferLegState: operation.transferLegState ?? null,
    })
    .where(eq(assetOperations.id, operation.id))
    .run();
  await ctx.writeAuditEntry("resolve_inherited_cost", "asset", operation.assetId, {
    batchId,
    kind: operation.kind,
    operationId: operation.id,
    transferCostMinor: operation.transferCostMinor ?? null,
    transferId: operation.transferId ?? null,
    transferLegState: operation.transferLegState ?? null,
  });
}
