/**
 * The contract every ficha surface family answers to (#1607).
 *
 * A family owns one kind of holding end to end: which rows it reads, which
 * sections it renders, and which server actions those sections post to. The page
 * knows none of that — it hands over a {@link FamilyContext} and gets back a
 * {@link HoldingSurface}.
 *
 * Three fields of the surface are NOT the family's own body. They are the parts
 * of the shared chrome that only the family can answer: what «Lo básico» shows
 * for this holding, what the Papelera would withdraw, and which ledger the
 * warning collector should fold. Naming them here — instead of letting the page
 * re-derive them from a handful of instrument booleans — is what keeps the page
 * out of the branching business.
 */

import type { FormErrorContext } from "@web/intake";
import type { WorthlineStore } from "@web/store";
import type { InvestmentAssetFull } from "@worthline/db";
import type {
  HoldingTrashImpact,
  InvestmentOperation,
  Liability,
  ManualAsset,
  ValueOnlyOpening,
} from "@worthline/domain";
import type { ReactNode } from "react";
import type { HoldingFamily } from "./holding-family";

/** Everything a family loader needs. Resolved once, by the page, for any family. */
export interface FamilyContext {
  /** The request-scoped store — every family read goes through it. */
  store: WorthlineStore;
  /** The holding's internal storage id. Never leaves the server (#1318). */
  id: string;
  /** The holding's own public `wl_hld_…` URL, where every form here returns. */
  currentUrl: string;
  /** The asset being edited, or null for a liability. */
  asset: ManualAsset | null;
  /** The liability being edited, or null for an asset. */
  liability: Liability | null;
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
  /**
   * The shared Cobros panel, already loaded for an asset (null for a liability).
   * Each family places it in its own order — it sits between the ledger surfaces
   * and the valuation ones, and only the family knows where that is.
   */
  payoutsPanel: ReactNode;
}

/** What a family hands back to the page. */
export interface HoldingSurface {
  family: HoldingFamily;
  /** The family's advanced-configuration body, in its own order. */
  body: ReactNode;
  /** The investment row «Lo básico» edits, when this family has one. */
  investment: InvestmentAssetFull | null;
  /** The «alta por valor total» state «Lo básico» warns about (#1329). */
  valueOnlyOpening: ValueOnlyOpening | null;
  /** Whether «Lo básico» still offers the raw balance door (#1290). */
  showRawBalanceForm: boolean;
  /** This holding's operations ledger — empty for a family that keeps none. */
  operations: InvestmentOperation[];
  /** What the Papelera would withdraw (#1365); null when it withdraws nothing. */
  trashImpact: HoldingTrashImpact | null;
  /** The Papelera's traspaso exit, offered only on a hand-written ledger (#1549). */
  manualLedger: { transferHref: string } | null;
}

/** The chrome contributions of a family that makes none. */
const NO_CHROME_CONTRIBUTION = {
  investment: null,
  manualLedger: null,
  operations: [],
  showRawBalanceForm: false,
  trashImpact: null,
  valueOnlyOpening: null,
} as const satisfies Omit<HoldingSurface, "body" | "family">;

/**
 * Build a surface, defaulting every chrome contribution the family does not make.
 * A family states only what it actually answers for — silence reads as "nothing",
 * which is what a coin collection or a cash account genuinely contributes.
 */
export function holdingSurface(
  family: HoldingFamily,
  parts: { body: ReactNode } & Partial<Omit<HoldingSurface, "body" | "family">>,
): HoldingSurface {
  return { ...NO_CHROME_CONTRIBUTION, family, ...parts };
}
