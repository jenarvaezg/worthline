/**
 * Pure interaction module for the multi-fund statement preview (PRD #669 S2,
 * #673, ADR 0055). The client island is a thin shell around this module
 * (docs/interaction-patterns.md §7): toggling a fund's checkbox or emptying its
 * symbol field never round-trips to the server — the confirm summary
 * (fondos incluidos, operaciones, importe, aviso de símbolo pendiente)
 * recomputes here, locally, from the current selection state.
 */

export type FundBucketKind = "matched" | "new";

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
