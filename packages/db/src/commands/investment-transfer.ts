import { assets } from "@db/schema";
import type { StoreContext } from "@db/store-context";
import { assertAssetAllowsOperationWrite } from "@db/valuation-guard";
import type {
  CurrencyCode,
  ExternalTransferInIntent,
  TransferIntent,
  TransferOrigin,
} from "@worthline/domain";
import {
  derivePosition,
  operationsUpTo,
  planExternalTransferIn,
  planTransfer,
} from "@worthline/domain";
import { eq } from "drizzle-orm";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { rippleHistoricalSnapshotsForOperations } from "./ripple-engine";
import type { UnitOfWork } from "./types";

/**
 * One traspaso, as the caller states it — the pure {@link TransferIntent} minus the
 * one field a caller must NOT supply, plus the ripple's clock.
 *
 * The currency is subtracted deliberately: it is a fact of the two holdings' ledgers,
 * read behind this command and refused when they disagree, so no form can declare a
 * currency the book does not hold.
 */
export type RecordTransferCommand = Omit<TransferIntent, "currency"> & {
  /** The day the ripple's cut-off is measured against. Defaults to the current date. */
  today?: string;
};

/**
 * An «alta por traspaso externo» as the caller states it — the pure
 * {@link ExternalTransferInIntent} minus the currency the destination's ledger already
 * declares, plus the ripple's clock.
 */
export type RecordExternalTransferInCommand = Omit<
  ExternalTransferInIntent,
  "currency"
> & {
  today?: string;
};

/**
 * The traspaso gate (#1479, PRD #1393): the ONE path that mints the two halves of a
 * traspaso, and the one that removes them.
 *
 * Why it is a command of its own and not two `recordInvestmentOperation` calls. The
 * pair's promise is "both or neither" — a `transfer_out` with no matching
 * `transfer_in` takes capital out of the book, and a lone `transfer_in` claims an
 * inherited cost with no origin. Two calls cannot promise that, and no caller should
 * have to. It also derives the figures nobody should have to type: the third figure of
 * each half — its units, or its VL when the units are the ones the confirmation
 * declared (#1544) — and the acquisition cost the units carry over.
 *
 * What it validates, and why each check is here rather than in the pure plan:
 *
 * - **Both holdings are in this book, and both are investments.** The database is
 *   per-workspace (ADR 0030), so the tenant scope IS the query — a holding from
 *   another workspace is one this book has never heard of. Both refusals THROW: the
 *   screen picks the destination from this workspace's own holdings, so an unknown or
 *   non-investment id is a bug or an attack, never a typo worth coaching in a field.
 * - **The two agree on a currency.** The inherited cost is an amount in the origin's
 *   currency written onto the destination's row; crossing currencies would need a rate
 *   nobody stated, and a holding's ledger sums ONE currency (#1401). A user genuinely
 *   CAN own a euro fund and a dollar fund, so this one is data, not a throw.
 * - **The origin's position is folded at the TRANSFER date** (`operationsUpTo`), not
 *   today: units bought after the traspaso neither back the amount that left nor lend
 *   their cost to the destination.
 *
 * The rest — the arithmetic and the refusals of the stated figures — is
 * `planTransfer`, pure and tested without a database.
 */
export function createInvestmentTransferCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<
  DatedFactCommandImplementations,
  | "recordTransferAndRipple"
  | "recordExternalTransferInAndRipple"
  | "deleteTransferAndRipple"
> {
  return {
    recordTransferAndRipple: async (command) => {
      const today = command.today ?? new Date().toISOString().slice(0, 10);

      if (command.originAssetId === command.destinationAssetId) {
        // Answered before the reads: with one id there is no pair of holdings to load,
        // and the write guards would happily pass on the same one twice.
        return { ok: false, violations: [{ code: "transfer_same_holding" }] };
      }

      const originCurrency = await readTransferSideCurrency(ctx, command.originAssetId);
      const destinationCurrency = await readTransferSideCurrency(
        ctx,
        command.destinationAssetId,
      );

      if (originCurrency !== destinationCurrency) {
        return {
          ok: false,
          violations: [
            {
              code: "transfer_currency_mismatch",
              destination: destinationCurrency,
              origin: originCurrency,
            },
          ],
        };
      }

      const plan = planTransfer(
        { ...command, currency: originCurrency },
        await originStateAt(stores, command, originCurrency),
      );
      if (!plan.ok) return plan;

      const dateKeys = [command.executedAt.slice(0, 10)];
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        await stores.operations.recordOperation(plan.value.out, { batchId });
        await stores.operations.recordOperation(plan.value.incoming, { batchId });
        await ripplePair(ctx, stores, {
          sides: [
            { assetId: command.originAssetId, operationDateKeys: dateKeys },
            { assetId: command.destinationAssetId, operationDateKeys: dateKeys },
          ],
          today,
        });
      });

      return { ok: true, value: undefined };
    },

    recordExternalTransferInAndRipple: async (command) => {
      const today = command.today ?? new Date().toISOString().slice(0, 10);
      const currency = await readTransferSideCurrency(ctx, command.destinationAssetId);

      const plan = planExternalTransferIn({ ...command, currency });
      if (!plan.ok) return plan;

      // ONE row, so one asset ripples — but through the same transaction shape as the
      // pair: an entry whose ripple fails must not stay in the book (ADR 0020).
      await ctx.transaction(async () => {
        const batchId = await uow.createFactBatch({ trigger: "manual" });
        await stores.operations.recordOperation(plan.value, { batchId });
        await ripplePair(ctx, stores, {
          sides: [
            {
              assetId: command.destinationAssetId,
              operationDateKeys: [command.executedAt.slice(0, 10)],
            },
          ],
          today,
        });
      });

      return { ok: true, value: undefined };
    },

    deleteTransferAndRipple: ({ transferId, today: todayOpt }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction so both deletions and the single ripple commit or roll back
      // together (ADR 0020) — the mirror of the write. The asset ids and dates come
      // from the deleted rows themselves; an unknown transferId ripples nothing.
      return ctx.transaction(async () => {
        const deleted = await stores.operations.deleteTransferPair(transferId);
        if (deleted.length === 0) return [];

        await ripplePair(ctx, stores, {
          mode: "delete",
          sides: deleted.map((row) => ({
            assetId: row.assetId,
            operationDateKeys: [row.executedAt.slice(0, 10)],
          })),
          today,
        });
        return deleted;
      });
    },
  };
}

/**
 * The origin's units and cost as of the transfer date, from its own ledger alone.
 *
 * ONE fold feeds both figures: the inherited cost is a proportion of the cost basis
 * over the units, so a pair taken from two folds could slice a cost that never
 * belonged to those units. Only the ORIGIN's ledger is read — the destination's says
 * nothing about what leaves, and reading it would be a query per traspaso for nothing.
 */
async function originStateAt(
  stores: DatedFactStores,
  command: Pick<RecordTransferCommand, "executedAt" | "originAssetId">,
  currency: CurrencyCode,
): Promise<TransferOrigin> {
  const dateKey = command.executedAt.slice(0, 10);
  const operations = await stores.operations.readOperations(command.originAssetId);
  const position = derivePosition(operationsUpTo(operations, dateKey), {
    assetId: command.originAssetId,
    currency,
  });

  return {
    costBasisMinor: position.costBasis.amountMinor,
    unitsHeld: position.currentUnits,
  };
}

/**
 * The currency one side of the pair keeps its ledger in, once both operation-write
 * guards have passed on it.
 * Throws when the holding is not in this book, is not an investment, or is
 * materialized from a connected source (whose position its own sync re-rolls, so a
 * hand-written half would be overwritten on the next one).
 */
async function readTransferSideCurrency(
  ctx: StoreContext,
  assetId: string,
): Promise<CurrencyCode> {
  const row = await ctx.db
    .select({ currency: assets.currency, type: assets.type })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  if (row.type !== "investment") {
    throw new Error(
      `Cannot traspasar units to or from non-investment asset ${assetId}: a traspaso ` +
        "moves participaciones between products that have participaciones.",
    );
  }

  await assertAssetAllowsOperationWrite(ctx, assetId);

  return row.currency as CurrencyCode;
}

/**
 * ONE batched ripple across both holdings (#1435). The pair shares a date, so a ripple
 * per half would re-derive the same band of history twice — the quadratic cliff that
 * slice cured for the statement import, and the same shape here.
 */
async function ripplePair(
  ctx: StoreContext,
  stores: DatedFactStores,
  params: {
    sides: ReadonlyArray<{ assetId: string; operationDateKeys: string[] }>;
    mode?: "record" | "delete";
    today: string;
  },
): Promise<void> {
  const workspace = await ctx.getWorkspace();
  if (!workspace) return;

  await rippleHistoricalSnapshotsForOperations(
    ctx,
    workspace,
    stores.snapshots.saveSnapshot,
    {
      assets: params.sides,
      ...(params.mode === undefined ? {} : { mode: params.mode }),
      today: params.today,
    },
  );
}
