import { assets } from "@db/schema";
import type { StoreContext } from "@db/store-context";
import { assertAssetAllowsOperationWrite } from "@db/valuation-guard";
import type {
  CurrencyCode,
  DecimalString,
  FundTransferOrigin,
  FundTransferPortion,
  OperationSource,
} from "@worthline/domain";
import { derivePosition, operationsUpTo, planFundTransfer } from "@worthline/domain";
import { eq } from "drizzle-orm";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { rippleHistoricalSnapshotsForOperations } from "./ripple-engine";
import type { UnitOfWork } from "./types";

/**
 * One traspaso, as the caller states it. The currency is NOT a field: it is a fact of
 * the two holdings' ledgers, read behind this command and refused when they disagree,
 * so no form can declare a currency the book does not hold.
 */
export interface RecordFundTransferCommand {
  /**
   * The id that will tie the two halves, and the two operation ids. All three are
   * supplied rather than minted here: a replayed submit has to land on the SAME pair
   * instead of a second one, so they are a function of the submission (#1394) — and
   * the store never reads a clock of its own (ADR 0024).
   */
  transferId: string;
  outOperationId: string;
  inOperationId: string;
  originAssetId: string;
  destinationAssetId: string;
  /** YYYY-MM-DD — the ONE date both halves carry. */
  executedAt: string;
  portion: FundTransferPortion;
  /** The origin's VL on `executedAt`. */
  originPricePerUnit: DecimalString;
  /** The destination's VL on the same date. */
  destinationPricePerUnit: DecimalString;
  /** The transfer commission; capitalized into the destination (ADR 0082). */
  feesMinor?: number;
  source?: OperationSource;
  occurredAt?: string;
  today?: string;
}

/**
 * The traspaso gate (#1479, PRD #1393): the ONE path that mints the two halves of a
 * traspaso, and the one that removes them.
 *
 * Why it is a command of its own and not two `recordInvestmentOperation` calls. The
 * pair's promise is "both or neither" — a `transfer_out` with no matching
 * `transfer_in` takes capital out of the book, and a lone `transfer_in` claims an
 * inherited cost with no origin. Two calls cannot promise that, and no caller should
 * have to. It also derives the three figures nobody should type: each half's units
 * (importe ÷ its OWN VL) and the acquisition cost the units carry over.
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
 * `planFundTransfer`, pure and tested without a database.
 */
export function createFundTransferCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  uow: UnitOfWork,
): Pick<
  DatedFactCommandImplementations,
  "recordTransferAndRipple" | "deleteTransferAndRipple"
> {
  return {
    recordTransferAndRipple: async (command) => {
      const today = command.today ?? new Date().toISOString().slice(0, 10);

      if (command.originAssetId === command.destinationAssetId) {
        // Answered before the reads: with one id there is no pair of holdings to load,
        // and the write guards would happily pass on the same one twice.
        return { ok: false, violations: [{ code: "transfer_same_holding" }] };
      }

      const origin = await assertTransferSide(ctx, command.originAssetId);
      const destination = await assertTransferSide(ctx, command.destinationAssetId);

      if (origin !== destination) {
        return {
          ok: false,
          violations: [{ code: "transfer_currency_mismatch", destination, origin }],
        };
      }

      const plan = planFundTransfer(
        { ...command, currency: origin },
        await originStateAt(stores, command, origin),
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
  command: Pick<RecordFundTransferCommand, "executedAt" | "originAssetId">,
  currency: CurrencyCode,
): Promise<FundTransferOrigin> {
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
 * Check one side of the pair and answer with the currency its ledger is kept in.
 * Throws when the holding is not in this book, is not an investment, or is
 * materialized from a connected source (whose position its own sync re-rolls, so a
 * hand-written half would be overwritten on the next one).
 */
async function assertTransferSide(
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
