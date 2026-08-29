/**
 * The contract every ficha surface family answers to (#1607).
 *
 * A family owns one kind of holding end to end: which rows it reads, which
 * sections it renders, and which server actions those sections post to. The page
 * knows none of that — it hands over a context and gets back a
 * {@link HoldingSurface}.
 *
 * Two things in the surface are NOT the family's own body. They are the parts of
 * the shared chrome that only the family can answer: what «Lo básico» shows for
 * this holding ({@link FichaBasics}), and what the Papelera would withdraw.
 * Naming them here — instead of letting the page re-derive them from a handful of
 * instrument booleans — is what keeps the page out of the branching business.
 *
 * The context comes in two halves on purpose. {@link FichaContext} is everything
 * resolved BEFORE the family is known, so the shared Cobros and Papelera panels
 * can take it without pretending to be a family. A family gets that plus its own
 * holding, non-nullable: the dispatch already proved which one it has, so no
 * loader carries a guard for a case it cannot be called in.
 */

import type { FormErrorContext } from "@web/intake";
import type { WorthlineStore } from "@web/store";
import type { InvestmentAssetFull } from "@worthline/db";
import type {
  HoldingTrashImpact,
  InvestmentOperation,
  Liability,
  ManualAsset,
  ValuationMethod,
  ValueOnlyOpening,
} from "@worthline/domain";
import type { ReactNode } from "react";
import type { HoldingFamily } from "./holding-family";

/** What the ficha knows before it knows which family the holding belongs to. */
export interface FichaContext {
  /** The request-scoped store — every family read goes through it. */
  store: WorthlineStore;
  /** The holding's internal storage id. Never leaves the server (#1318). */
  id: string;
  /** The holding's own public `wl_hld_…` URL, where every form here returns. */
  currentUrl: string;
  /** Every asset in the workspace — the traspaso picker's candidate pool (#1480). */
  allAssets: ManualAsset[];
  /** Today, as an ISO date key. One clock read for the whole page. */
  today: string;
  privacyMode: boolean;
  /** Demo skips optimistic mutations — the write-guard rejects them (§10). */
  isDemo: boolean;
  formError: FormErrorContext | null;
  /** When the persistence healthcheck last ran — the price-freshness clock. */
  checkedAt: string;
  /** `?archivar=1`: the Papelera's «Lo traspasé a…» exit came back here (#1549). */
  archiveOriginAfterTransfer: boolean;
}

/** An asset family's context: the ficha's, plus the asset and the shared panel. */
export interface AssetFamilyContext extends FichaContext {
  asset: ManualAsset;
  /**
   * The shared Cobros panel, already loaded. Each family places it in its own
   * order — it sits between the ledger surfaces and the valuation ones, and only
   * the family knows where that is.
   */
  payoutsPanel: ReactNode;
}

/** The debt family's context. A liability pays nobody, so it takes no panel. */
export interface DebtFamilyContext extends FichaContext {
  liability: Liability;
}

/** The Papelera's traspaso exit, offered only on a hand-written ledger (#1549). */
export interface ManualLedgerExit {
  transferHref: string;
}

/** What the family answers for in the shared «Lo básico» form. */
export interface FichaBasics {
  /**
   * The holding's valuation method (#152, ADR 0014) — which fields «Lo básico»
   * offers at all. Filled in by the dispatch, which computed it to route in the
   * first place, so no family repeats the derivation and the page never asks.
   */
  method: ValuationMethod;
  /** The investment row «Lo básico» edits, when this family has one. */
  investment: InvestmentAssetFull | null;
  /** The «alta por valor total» state «Lo básico» warns about (#1329). */
  valueOnlyOpening: ValueOnlyOpening | null;
  /** Whether «Lo básico» still offers the raw balance door (#1290). */
  showRawBalanceForm: boolean;
  /** Identity fixed by a Numista source: name/type/value are read-only (ADR 0016). */
  isCoinCollection: boolean;
  /** Identity fixed by a Binance source, same reason (ADR 0021). */
  isBinanceHolding: boolean;
}

/** What a family hands back to the page. */
export interface HoldingSurface {
  family: HoldingFamily;
  /** The family's advanced-configuration body, in its own order. */
  body: ReactNode;
  basics: FichaBasics;
  /** This holding's operations ledger — empty for a family that keeps none. */
  operations: InvestmentOperation[];
  /** What the Papelera would withdraw (#1365); null when it withdraws nothing. */
  trashImpact: HoldingTrashImpact | null;
  manualLedger: ManualLedgerExit | null;
}

/** The chrome contributions of a family that makes none. */
const NO_CHROME_CONTRIBUTION = {
  basics: {
    investment: null,
    isBinanceHolding: false,
    isCoinCollection: false,
    // Overwritten by the dispatch for an asset; a liability's «Lo básico» never
    // reads it (its form is `LiabilityEditForm`, which takes no method).
    method: "stored",
    showRawBalanceForm: false,
    valueOnlyOpening: null,
  },
  manualLedger: null,
  operations: [],
  trashImpact: null,
} as const satisfies Omit<HoldingSurface, "body" | "family">;

/**
 * Build a surface, defaulting every chrome contribution the family does not make.
 * A family states only what it actually answers for — silence reads as "nothing",
 * which is what a coin collection or a cash account genuinely contributes.
 */
export function holdingSurface(
  family: HoldingFamily,
  parts: { body: ReactNode } & Partial<
    Omit<HoldingSurface, "basics" | "body" | "family">
  > & { basics?: Partial<FichaBasics> },
): HoldingSurface {
  return {
    ...NO_CHROME_CONTRIBUTION,
    family,
    ...parts,
    basics: { ...NO_CHROME_CONTRIBUTION.basics, ...parts.basics },
  };
}
