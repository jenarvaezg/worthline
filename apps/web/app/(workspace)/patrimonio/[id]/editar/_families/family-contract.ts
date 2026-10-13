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
 * Since #1826 every family is laid out the same way ({@link FichaLayout}): a state
 * header with an action bar, a side panel per action, and tabs. The ficha is built
 * from common pieces (`_ficha/`), so a family states only WHAT it carries: its
 * figures, its actions, its tabs — and #1850 retired the single column it replaced.
 *
 * The context comes in two halves on purpose. {@link FichaContext} is everything
 * resolved BEFORE the family is known, so the shared Cobros and Papelera panels
 * can take it without pretending to be a family. A family gets that plus its own
 * holding, non-nullable: the dispatch already proved which one it has, so no
 * loader carries a guard for a case it cannot be called in.
 */

import type { RowKeys } from "@web/_components/fresh-row-keys";
import type { FormErrorContext } from "@web/intake";
import type { FichaTarget } from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import type { WorthlineStore } from "@web/store";
import type { InvestmentAssetFull } from "@worthline/db";
import type {
  CurrencyCode,
  DatedPayout,
  DomainWarning,
  HoldingTrashImpact,
  HoldingWarningCode,
  Liability,
  ManualAsset,
  ValuationMethod,
  ValueOnlyOpening,
  WarningOverride,
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
  /** The workspace's base currency — what the board's figures are measured in. */
  baseCurrency: CurrencyCode;
  privacyMode: boolean;
  /** Demo skips optimistic mutations — the write-guard rejects them (§10). */
  isDemo: boolean;
  formError: FormErrorContext | null;
  /** When the persistence healthcheck last ran — the price-freshness clock. */
  checkedAt: string;
  /** `?archivar=1`: the Papelera's «Lo traspasé a…» exit came back here (#1549). */
  archiveOriginAfterTransfer: boolean;
  /**
   * The «Es intencional» acknowledgements, already read for the band: a family
   * that prints a warning beside its figure (#1828) asks the same list.
   */
  overrides: readonly WarningOverride[];
}

/**
 * The shared Cobros panel, loaded once by the page and PLACED by the family (#1607),
 * split (#1826) into a tab and an action, each returning to the tab where it shows.
 */
export interface PayoutsPanel {
  /**
   * What it paid and is declared to pay: the ficha's «Cobros» tab. `addLink` is
   * the door to the entry panel, printed in the one line a holding with no cobros
   * shows instead of a block of zeros (#1830).
   */
  record: (currentUrl: string, addLink?: ReactNode) => ReactNode;
  /** The two entry forms: a tabbed ficha's «Añadir cobro» panel. */
  entry: (currentUrl: string) => ReactNode;
  /** How many cobros it has, one-off or recurring — the tab's count. */
  count: number;
  /**
   * The keys of the rows it lists — the grid's, and the declared recurring cobros' —
   * so a tabbed ficha can point at a new one (#1829, #1731 review).
   */
  rows: Required<Pick<RowKeys, "cobros" | "recurrentes">>;
  /** Its payouts up to today, dated as the return engine reads them (#657). */
  datedPayouts: DatedPayout[];
}

/** An asset family's context: the ficha's, plus the asset and the shared panel. */
export interface AssetFamilyContext extends FichaContext {
  asset: ManualAsset;
  /**
   * The shared Cobros panel, already loaded. Each family places it in its own
   * order — it sits between the ledger surfaces and the valuation ones, and only
   * the family knows where that is.
   */
  payoutsPanel: PayoutsPanel;
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
  /** Identity fixed by a Numista source: name/type/value are read-only (ADR 0016). */
  isCoinCollection: boolean;
  /** Identity fixed by a Binance source, same reason (ADR 0021). */
  isBinanceHolding: boolean;
}

/** How an action sits in the bar: the habitual one, at hand, or inside «Más». */
export type FichaActionTier = "primary" | "secondary" | "more";

/** One action of the tabbed ficha: a button in the bar, a form in the side panel. */
export interface FichaAction {
  /** Its `?accion=` value. */
  key: string;
  label: string;
  tier: FichaActionTier;
  /** What the side panel holds while it is open — the action's form. */
  content: ReactNode;
  /**
   * The label of the success notice's offer to open this form again, keeping its
   * date and currency (#1829) — «Añadir otra». Absent: the action offers none.
   */
  again?: string;
}

/** One tab of the tabbed ficha. */
export interface FichaTab {
  /** Its `?pestaña=` value. */
  key: string;
  label: string;
  /** The label where four tabs must fit 390 px, when it differs. */
  shortLabel?: string;
  /** What it holds, shown grey beside the label; absent when counting means nothing. */
  count?: number;
  content: ReactNode;
}

/** One figure in the state header's row, under the value. */
export interface FichaFigure {
  /** Stable within the row. */
  key: string;
  label: ReactNode;
  value: ReactNode;
  /** The sign colour, for a figure that is a movement (canon §6) — never a total. */
  tone?: "pos" | "neg";
  /**
   * `text` for a value that is a word, not a figure — a rung, «Caja» (#1846): set in
   * the body face, because the numeric one is for figures (canon §3).
   */
  kind?: "text";
  /** What qualifies the figure: where its price comes from, how fresh it is. */
  detail?: ReactNode;
}

/** Where a warning is fixed on the ficha: a tab, and the field in it to focus (#1828). */
export interface FichaFix {
  tab: string;
  /** The `name` of the field to focus once the tab is on show. */
  field?: string;
  /** The link's words: «Ver operaciones». */
  label: string;
}

/** What a ficha carries — the common pieces render the rest (#1826). */
export interface FichaLayout {
  /** The instrument, in words, under the name. */
  instrument: string | null;
  /** The holding's value: the one dominant figure of the page. */
  value: string;
  figures: readonly FichaFigure[];
  /** Its actions in bar order — the first `primary` is the habitual one. */
  actions: readonly FichaAction[];
  /** Its own tabs, in order; the page appends «Datos del activo». */
  tabs: readonly FichaTab[];
  /** By `formId`: the tab or panel whose form prints a refusal that came back. */
  errorTargets: Readonly<Record<string, FichaTarget>>;
  /**
   * The `formId`s of the family's own forms that print their own refusal, inside
   * the panel (#1848): the page's band leaves them out, so a refusal is said once.
   * Named by the family (#1850), because the same `formId` («cadence») may be
   * printed by its own form on one ficha and by the band on another; the page lists
   * only the chrome's (Cobros, Papelera).
   */
  ownErrorForms?: readonly string[];
  /**
   * The keys of the rows each tab lists, by list name, so the ficha can point at the
   * one a terminal just added (#1829).
   */
  rows?: RowKeys;
  /**
   * The holding's active warnings, read ONCE (`holdingWarnings`, #1731 review): the
   * family reads them to print its inline ones, and the page hands the same list to
   * the band, which prints the rest.
   */
  warnings: readonly DomainWarning[];
  /**
   * The warning codes this ficha prints beside the figure they are about (#1828) —
   * the band above the header leaves them out, so a warning is in exactly one place.
   */
  inlineWarnings?: readonly HoldingWarningCode[];
  /** By warning code: where the band links for that warning to be fixed (#1828). */
  warningFixes?: Readonly<Partial<Record<HoldingWarningCode, FichaFix>>>;
  /** Client state its tabs and panels share, wrapped around the whole ficha. */
  wrap?: (ficha: ReactNode) => ReactNode;
}

/** What a family hands back to the page. */
export interface HoldingSurface {
  family: HoldingFamily;
  /** What its ficha carries: the page lays every family out the same way (#1850). */
  ficha: FichaLayout;
  basics: FichaBasics;
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
    valueOnlyOpening: null,
  },
  manualLedger: null,
  trashImpact: null,
} as const satisfies Omit<HoldingSurface, "family" | "ficha">;

/** What a family may say about the shared chrome; whatever it leaves out is "nothing". */
type ChromeContributions = Partial<
  Omit<HoldingSurface, "basics" | "family" | "ficha">
> & { basics?: Partial<FichaBasics> };

/**
 * Build a surface, defaulting every chrome contribution the family does not make.
 * A family states only what it actually answers for — silence reads as "nothing",
 * which is what a coin collection or a cash account genuinely contributes.
 */
export function holdingSurface(
  family: HoldingFamily,
  { basics, ficha, ...contributions }: { ficha: FichaLayout } & ChromeContributions,
): HoldingSurface {
  return {
    ...NO_CHROME_CONTRIBUTION,
    ...contributions,
    basics: { ...NO_CHROME_CONTRIBUTION.basics, ...basics },
    family,
    ficha,
  };
}
