/**
 * Applying ONE correction plan (#1051, PRD #1048) — the deepest of the
 * assistant-proposal handlers, and the only one that fans a single confirmed
 * intent out over several write seams. It lives beside the gate that dispatches
 * to it (`assistant-proposal-apply.ts`) rather than inside the command host,
 * which only assembles seams.
 */

import type { AssetStore } from "@db/asset-store";
import type { CorrectionEdit, CorrectionPlan } from "@db/correction-plan";
import type { AddBalanceRebaselineInput } from "@db/liability-balance-rebaseline-store";
import type { OperationsStore } from "@db/operations-store";
import type { StoreContext } from "@db/store-context";
import type { LiabilityStore } from "@db/store-types";
import {
  checkOwnershipSplit,
  detectValueOnlyOpening,
  resolveInstrumentIdentityFill,
  valueOnlySymbolGuardMessage,
} from "@worthline/domain";
import type { DatedFactCommandImplementations } from "./command-implementation-types";
import type {
  ImportBalanceHistoryCommand,
  ImportBalanceHistoryResult,
} from "./import-balance-history";
import type { DebtRippleCounts, FactBatchInput } from "./types";

/**
 * Read + write seams for the identity fill a correction can carry (#1349). The
 * reads are the re-resolution against live data — the portfolio for the identity
 * rule, the ledger for the #1329 guard; `clearPriceCache` is the third reason the
 * operations store rides along, since a new symbol must not be priced from the
 * cache row the old configuration left behind.
 */
export type InvestmentIdentitySeams = Pick<
  AssetStore,
  "readInvestmentAssetsWithMeta" | "patchInvestmentIdentity"
> &
  Pick<OperationsStore, "clearPriceCache" | "readOperations">;

/**
 * The staleness guard both debt-side proposals share (#1051/#1245): the live
 * balance at the frozen `asOf` must still be what the draft was armed against.
 * `asOf` is frozen at draft time, so confirming a day later is fine — only a fact
 * that MOVED the curve in between fails, which is exactly the case where the
 * previewed arithmetic no longer describes what would be written.
 */
export async function assertLiveBalanceUnchanged(
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">,
  revalidation: { liabilityId: string; asOf: string; expectedBalanceMinor: number },
): Promise<void> {
  const live = await liabilityReads.debtBalanceAtDate(
    revalidation.liabilityId,
    revalidation.asOf,
  );
  if (live === revalidation.expectedBalanceMinor) return;
  const error = new Error(
    "El holding cambió desde que se preparó la propuesta. Vuelve a pedirla con los datos de ahora.",
  );
  Object.assign(error, { code: "correction_draft_stale" });
  throw error;
}

/**
 * The collaborators one correction edit can need. Grouped rather than threaded
 * positionally: the loop already carries three, and every new edit kind that needs
 * a seam would add another parameter to both functions below.
 */
export interface CorrectionApplySeams {
  datedFacts: DatedFactCommandImplementations;
  liabilityReads: Pick<LiabilityStore, "debtBalanceAtDate">;
  investmentIdentity: InvestmentIdentitySeams;
}

/**
 * Apply one correction plan (#1051) inside the caller's transaction: revalidate
 * against live data first (a stale draft fails honestly and nothing persists),
 * validate any ownership split at the trust boundary, then dispatch each edit to
 * the already-shipped #997 write commands with the `"assistant"` provenance. The
 * radius is one holding, save for the atomic debt↔asset pair an ownership fix
 * carries as two edits in the same transaction.
 */
export async function applyCorrectionPlan(
  ctx: StoreContext,
  seams: CorrectionApplySeams,
  plan: CorrectionPlan,
  today: string,
): Promise<void> {
  if (plan.mode !== "anchor-only") {
    // The reconstruct depth is applied through the atomic balance-history import,
    // never this per-edit loop — the caller routes it before reaching here.
    throw new Error(`Correction plan mode "${plan.mode}" is not applied here.`);
  }
  if (plan.revalidation) {
    await assertLiveBalanceUnchanged(seams.liabilityReads, plan.revalidation);
  }
  for (const edit of plan.edits) {
    await applyCorrectionEdit(ctx, seams, edit, today);
  }
}

/**
 * Fill an investment's identity, re-resolved against LIVE data (#1349). The draft
 * carries the declaration, never a decision: between arming the card and
 * confirming it, a sibling proposal or the ficha may have written the very field
 * this edit believes is empty, or given the key to a neighbour. Re-running the
 * pure rule here is what makes «solo rellenar hueco» true at write time instead
 * of at draft time; the throw rolls the whole apply back and the action surfaces
 * the reason.
 */
async function applyInvestmentIdentityFill(
  seams: InvestmentIdentitySeams,
  edit: Extract<CorrectionEdit, { kind: "investment_identity" }>,
): Promise<void> {
  const portfolio = await seams.readInvestmentAssetsWithMeta();
  const target = portfolio.find((holding) => holding.id === edit.assetId);
  if (!target) {
    throw new Error("Esa inversión ya no existe en el workspace.");
  }
  const resolved = resolveInstrumentIdentityFill({
    declaration: edit.declaration,
    portfolio,
    target,
  });
  if (!resolved.ok) throw new Error(resolved.error);

  // The #1329 guard, live too: the ledger CAN become the 1-participación opening
  // between drafting and confirming (an operation deleted on the ficha is enough),
  // and then this write would hand a 574,48 € holding to one share's quote. No
  // figure to quote here — pricing it would be a network call inside the apply —
  // so the message degrades to the honest half the pure module already has.
  if (resolved.patch.providerSymbol !== undefined) {
    const valueOnly = detectValueOnlyOpening(await seams.readOperations(edit.assetId));
    if (valueOnly) {
      throw new Error(
        valueOnlySymbolGuardMessage({
          opening: valueOnly,
          symbol: resolved.patch.providerSymbol,
        }),
      );
    }
  }

  // `priceProvider` is deliberately NOT written: `readInvestmentAssetsWithMeta`
  // derives the default for a NULL column (and it is what feeds the refresh), so
  // stamping it would be an invisible side effect of an identity fill.
  await seams.patchInvestmentIdentity(edit.assetId, resolved.patch);
  // A cache row minted under the previous configuration would price the new
  // symbol from the old figure — the editing surface clears it for the same reason.
  if (resolved.patch.providerSymbol !== undefined) {
    await seams.clearPriceCache(edit.assetId);
  }
}

async function assertOwnershipSplit(
  ctx: StoreContext,
  ownership: { ownership?: Parameters<typeof checkOwnershipSplit>[1] },
): Promise<void> {
  if (!ownership.ownership) return;
  const workspace = await ctx.getWorkspace();
  if (!workspace) throw new Error("Workspace no inicializado.");
  // A correction that repays/reassigns a co-owned home mirrors a known partial
  // split, exactly as the manual ownership command allows.
  const violation = checkOwnershipSplit(workspace, ownership.ownership, {
    allowKnownPartial: true,
  });
  if (violation) throw new Error("El reparto de titularidad no suma 100 %.");
}

async function applyCorrectionEdit(
  ctx: StoreContext,
  seams: CorrectionApplySeams,
  edit: CorrectionEdit,
  today: string,
): Promise<void> {
  const { datedFacts } = seams;
  switch (edit.kind) {
    case "debt_rebaseline":
      await datedFacts.addBalanceRebaselineAndRipple(edit.input, { today });
      return;
    case "balance_anchor":
      await datedFacts.addBalanceAnchorAndRipple(edit.input, { today });
      return;
    case "valuation_anchor":
      await datedFacts.addValuationAnchorAndRipple(edit.input, { today });
      return;
    case "debt_model":
      await datedFacts.changeDebtModelAndRipple(edit.liabilityId, edit.debtModel, {
        today,
      });
      return;
    case "liability_cadence":
      await datedFacts.setValuationCadenceAndRipple(edit.liabilityId, edit.cadence, {
        today,
      });
      return;
    case "housing_cadence":
      await datedFacts.setHousingValuationCadenceAndRipple(edit.assetId, edit.cadence, {
        today,
      });
      return;
    case "amortization_plan":
      await datedFacts.updateAmortizationPlanAndRipple(edit.planId, edit.input, {
        liabilityId: edit.liabilityId,
        today,
      });
      return;
    case "liability_config":
      await assertOwnershipSplit(ctx, edit.patch);
      await datedFacts.updateLiabilityAndRippleOwnership(edit.liabilityId, edit.patch);
      return;
    case "asset_config":
      await assertOwnershipSplit(ctx, edit.patch);
      await datedFacts.updateAssetAndRippleOwnership(edit.assetId, edit.patch, { today });
      return;
    case "investment_identity":
      // No ripple: identity is a mapping route, not a dated fact. The next price
      // refresh is what re-values the holding through the new symbol.
      await applyInvestmentIdentityFill(seams.investmentIdentity, edit);
      return;
    case "investment_operations":
      await datedFacts.recordOperationsAndRipple({
        assetId: edit.assetId,
        creates: edit.creates,
        deletes: edit.deletes,
        overwrites: edit.overwrites,
        today,
      });
      return;
  }
}

/**
 * What the "reconstruct" depth of a correction (#1053) carries: the freshly
 * re-projected re-baseline chain the confirm composed from the (possibly
 * point-edited) series. The persisted plan keeps the raw series + before-values.
 */
export interface CorrectionReconstruction {
  liabilityId: string;
  rebaselines: AddBalanceRebaselineInput[];
  /**
   * The endpoint of the accepted curve today (#1422). Present only when it
   * differs from the stored `current_balance_minor`: applying a document the user
   * confirmed must not leave the hand-typed anchor contradicting it.
   */
  redeclaredBalanceMinor?: number;
}

/** The two seams the reconstruct depth writes through. */
export interface CorrectionReconstructionSeams {
  factPersistence: Pick<LiabilityStore, "updateLiabilityBalance">;
  importBalanceHistory: (
    params: ImportBalanceHistoryCommand,
    batch: FactBatchInput,
  ) => Promise<ImportBalanceHistoryResult>;
}

/**
 * Apply the re-projected series as ONE atomic batch with ONE ripple from the
 * oldest date, instead of the anchor-only edit loop above. The confirm already
 * re-projected the series against live data, and (#1422) may have re-derived the
 * declared balance from that curve — same transaction, so the anchor and the
 * re-baselines that justify it never diverge.
 */
export async function applyCorrectionReconstruction(
  seams: CorrectionReconstructionSeams,
  reconstruct: CorrectionReconstruction,
  today: string,
): Promise<DebtRippleCounts> {
  // El saldo va PRIMERO, y el import después: el import ripplea desde la fecha
  // más antigua, y las fechas anteriores al primer re-baseline se valoran con el
  // saldo guardado. Al revés, ese ripple congelaría en los snapshots el ancla
  // vieja que esta misma llamada viene a corregir.
  if (reconstruct.redeclaredBalanceMinor !== undefined) {
    await seams.factPersistence.updateLiabilityBalance(
      reconstruct.liabilityId,
      reconstruct.redeclaredBalanceMinor,
    );
  }
  const outcome = await seams.importBalanceHistory(
    {
      liabilityId: reconstruct.liabilityId,
      rebaselines: reconstruct.rebaselines,
      today,
    },
    { trigger: "assistant" },
  );
  return outcome.snapshots;
}
