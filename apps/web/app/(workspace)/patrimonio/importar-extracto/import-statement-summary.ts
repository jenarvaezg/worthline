/**
 * Pure interaction module for the multi-fund statement preview (PRD #669 S2,
 * #673, ADR 0055). The client island is a thin shell around this module
 * (docs/interaction-patterns.md §7): toggling a fund's checkbox, emptying its
 * symbol field, or naming which of two holdings an identifier is (#1366) never
 * round-trips to the server — the per-fund selection rules and the confirm
 * summary (fondos incluidos, operaciones, importe, avisos pendientes) all live
 * here, testable without a DOM.
 */

export type FundBucketKind = "matched" | "new";

/** One fund row's form controls, as the island holds them. */
export interface FundSelectionFlags {
  included: boolean;
  replaceOpening: boolean;
  /** Whether the (editable) provider-symbol field is empty. "new" rows only. */
  symbolEmpty: boolean;
  /**
   * The investment the user named for an identifier several holdings claim
   * (#1366). Empty while unchosen — and while it is empty the fund cannot be
   * included, because every figure in its row belongs to one holding or another.
   */
  assetId: string;
}

/** A row's opening state, in the terms the selection rules actually read. */
export type FundSelectionSeed =
  | {
      bucket: "matched";
      /** More than one investment claims the identifier. */
      ambiguous: boolean;
      /** The best-ranked claimant — the target when there is only one. */
      assetId: string;
      /** Whether that claimant's merge would replace an opening operation. */
      replacesOpening: boolean;
    }
  | { bucket: "new"; suggestedSymbol: string };

/**
 * How a row starts. An ambiguous identifier starts unchosen AND excluded: the
 * best-ranked claimant is an ordering, not an answer, and pre-checking it would
 * smuggle back the very by-creation-order pick #1366 exists to stop.
 */
export function defaultFundSelection(seed: FundSelectionSeed): FundSelectionFlags {
  if (seed.bucket === "new") {
    return {
      assetId: "",
      included: seed.suggestedSymbol !== "",
      replaceOpening: false,
      symbolEmpty: seed.suggestedSymbol === "",
    };
  }
  return {
    assetId: seed.ambiguous ? "" : seed.assetId,
    included: !seed.ambiguous,
    replaceOpening: seed.replacesOpening,
    symbolEmpty: false,
  };
}

/**
 * Name the investment an ambiguous identifier belongs to. Naming it IS the
 * decision to import it, and clearing the choice takes the fund back out rather
 * than leaving it armed without a target. Every figure in the row is that
 * holding's, so the opening-replacement default is re-read from the newly chosen
 * claimant instead of carrying the previous one's over.
 */
export function chooseFundHolding(
  current: FundSelectionFlags,
  choice: { assetId: string; replacesOpening: boolean },
): FundSelectionFlags {
  return {
    ...current,
    assetId: choice.assetId,
    included: choice.assetId !== "",
    replaceOpening: choice.replacesOpening,
  };
}

/** Whether the row is still waiting for the user to name a holding (#1366). */
export function isFundChoicePending(
  row: { bucket: FundBucketKind; ambiguous?: boolean },
  flags: Pick<FundSelectionFlags, "assetId">,
): boolean {
  return row.bucket === "matched" && row.ambiguous === true && flags.assetId === "";
}

/** One fund row's current selection state, as reflected by its form controls. */
export interface FundSelectionState {
  isin: string;
  bucket: FundBucketKind;
  included: boolean;
  /** Whether the (editable) provider-symbol field is empty. Ignored for "matched". */
  symbolEmpty: boolean;
  /**
   * The identifier is claimed by more than one investment and the user has not
   * named which yet (#1366). Ignored for "new". Such a fund cannot be included —
   * there is no safe default target — so it counts OUTSIDE the inclusion filter,
   * as an unfinished decision rather than a property of the selection.
   */
  choicePending?: boolean;
  executedCount: number;
  skippedCount: number;
  amountMinor: number;
}

export interface ImportStatementSummary {
  /** Funds currently checked to include. */
  fundCount: number;
  /** Funds currently unchecked. */
  excludedCount: number;
  matchedCount: number;
  newCount: number;
  /** Executed rows across every INCLUDED fund. */
  executedRows: number;
  /** Sum of every included fund's executed-rows amount, in minor units. */
  amountMinor: number;
  /**
   * Included "new" funds whose symbol field is empty — these would create with
   * MISSING_PROVIDER_SYMBOL raised (ADR 0055).
   */
  unresolvedSymbolCount: number;
  /**
   * Funds whose identifier still names two investments instead of one (#1366),
   * included or not. They stay out of the import until the user picks — ADR 0055
   * decision 4: one unresolvable identifier is excluded, never a hostage to the
   * other 25 — so the summary says so out loud instead of dropping them quietly.
   */
  pendingChoiceCount: number;
}

/**
 * Recompute the confirm summary from the current per-fund selection state. Pure
 * and synchronous — the client shell calls this on every checkbox/symbol change.
 */
export function summarizeImportSelection(
  funds: readonly FundSelectionState[],
): ImportStatementSummary {
  const included = funds.filter((fund) => fund.included);

  return {
    amountMinor: included.reduce((sum, fund) => sum + fund.amountMinor, 0),
    excludedCount: funds.length - included.length,
    executedRows: included.reduce((sum, fund) => sum + fund.executedCount, 0),
    fundCount: included.length,
    matchedCount: included.filter((fund) => fund.bucket === "matched").length,
    newCount: included.filter((fund) => fund.bucket === "new").length,
    pendingChoiceCount: funds.filter(
      (fund) => fund.bucket === "matched" && fund.choicePending === true,
    ).length,
    unresolvedSymbolCount: included.filter(
      (fund) => fund.bucket === "new" && fund.symbolEmpty,
    ).length,
  };
}

/** Spanish singular/plural count phrase, e.g. `pluralize(1, "fondo", "fondos")`. */
export function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
