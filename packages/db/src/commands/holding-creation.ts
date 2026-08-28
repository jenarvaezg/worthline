import type { StoreContext } from "@db/store-context";
import type { DomainViolation } from "@worthline/domain";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";

/**
 * The alta gate (#1599): creating a holding is ONE unit of work.
 *
 * Why it is a command of its own and not the two calls it replaces. An alta was
 * never one write: an investment is a row PLUS the operation that gives it a
 * value (an opening BUY, or the `transfer_in` that arrived from another
 * institution), and a debt is a row PLUS its model PLUS — on the «alta por estado
 * actual» path (ADR 0056) — its plan and its re-baseline. Splitting that across
 * calls meant a second write could fail with the first one already committed, and
 * the owner was left with what the action then called an error: a fondo at 0 €
 * with no operations, a deuda with no model. Nothing in the type system stopped
 * it, exactly as ADR 0020 describes for the persist/ripple pair.
 *
 * So the seam owns the whole alta. It composes the family commands that already
 * own each half — the ripple included — inside ONE transaction; nested
 * transactions flatten into it (`StoreContext.transaction`), so the composition
 * costs no second BEGIN and every half commits or rolls back together.
 *
 * The pure refusals stay OUTSIDE. Everything a caller can check before touching
 * the book (the parsed figures, the domain guard on the operation, the ownership
 * split) is the caller's job and must fail before the alta is ever attempted; what
 * lands here is what can only be refused once the holding exists — the traspaso
 * gate reads the destination's own currency — plus every failure the database
 * itself can raise.
 */
export function createHoldingCreationCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
  composed: Pick<
    DatedFactCommandImplementations,
    | "recordOperationAndRipple"
    | "recordExternalTransferInAndRipple"
    | "createCurrentStateDebtAndRipple"
  >,
): Pick<
  DatedFactCommandImplementations,
  "createInvestmentHoldingAndRipple" | "createDebtHoldingAndRipple"
> {
  return {
    createInvestmentHoldingAndRipple: async ({ asset, entry, today }) => {
      try {
        await ctx.transaction(async () => {
          await stores.assets.createInvestmentAsset(asset);

          if (entry?.kind === "opening") {
            await composed.recordOperationAndRipple(entry.operation, { today });
            return;
          }

          if (entry?.kind === "external_transfer_in") {
            const result = await composed.recordExternalTransferInAndRipple({
              ...entry.transfer,
              destinationAssetId: asset.id,
              today,
            });
            // The gate answers a bad figure with data, not an exception. Here it
            // has to become one for the length of the rollback: the holding is
            // only half of the alta, so a refused entry must take the row it was
            // going to value down with it.
            if (!result.ok) throw new HoldingCreationRefused(result.violations);
          }
        });
      } catch (error) {
        if (error instanceof HoldingCreationRefused) {
          return { ok: false, violations: error.violations };
        }
        throw error;
      }

      return { ok: true, value: undefined };
    },

    createDebtHoldingAndRipple: async ({ currentState, debtModel, liability, today }) => {
      await ctx.transaction(async () => {
        await stores.liabilities.createLiability(liability);
        // The model is what decides how the balance is valued (ADR 0031), so a
        // deuda that lands without it is not a lighter version of itself — it is
        // a deuda whose curve nobody can draw.
        await stores.liabilities.setDebtModel(liability.id, debtModel);

        if (currentState) {
          await composed.createCurrentStateDebtAndRipple({
            plan: currentState.plan,
            rebaseline: currentState.rebaseline,
            today,
          });
        }
      });
    },
  };
}

/**
 * A domain refusal raised from inside the alta's transaction, so the rollback
 * runs. Caught at the seam boundary and turned back into a `{ ok: false }`
 * result — it never leaks past this module.
 */
class HoldingCreationRefused extends Error {
  constructor(readonly violations: [DomainViolation, ...DomainViolation[]]) {
    super("holding creation refused");
    this.name = "HoldingCreationRefused";
  }
}
