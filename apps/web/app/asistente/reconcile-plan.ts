/**
 * The reconcile interaction module (PRD #1103 S5, #1108) — the pure core behind
 * the "sube un Excel y cuádrame la cartera" surface. It joins the S4 extractor's
 * `positions_movements` document to the current portfolio through the S1 matcher
 * and produces, per holding, an editable decision: **create** a new holding,
 * **update** a matched one, or **leave** it. It then answers the two questions the
 * superficie B card asks — the net-worth impact header (antes → después) and the
 * per-row decision — and exposes the immutable editing operations (reassign
 * match↔new, discard/restore) the user drives from the preview.
 *
 * Pure and I/O-free (`docs/interaction-patterns.md`, ADR 0036): no store, no
 * clock, no persistence, client-safe (no `node:*`). The server builder validates
 * the untrusted document and reads the portfolio; this module only computes over
 * plain shapes, so the same functions drive the React card's client-side edits and
 * the confirm action's re-resolution against live data.
 */

import type {
  Instrument,
  MatchCandidateRow,
  MatchPortfolioHolding,
  RowMatch,
} from "@worthline/domain";
import { matchHoldings, reassignToCandidate, reassignToNew } from "@worthline/domain";
import type {
  ExtractedPositionsMovementsDocument,
  HoldingFidelity,
} from "./attachment-extraction-contract";
import { movementLinksToHolding } from "./attachment-extraction-contract";
import { mapReconcileTypeToInstrument } from "./reconcile-instrument-mapping";

/**
 * The instrument families the reconcile writes in v1: derived investments, the
 * holdings a positions/cartera spreadsheet carries and the ones the atomic apply
 * routes through the proven investment statement-import engine. Stored, debt and
 * appreciating rows are shown and tier-marked but left (the chat alta of S2 covers
 * those families); an honest, documented v1 boundary — never a silent drop.
 */
const INVESTMENT_INSTRUMENTS: ReadonlySet<Instrument> = new Set<Instrument>([
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
  "crypto",
]);

/** Effective decision of a row: an excluded ("descartado") row always leaves. */
export type ReconcileDecision = "create" | "update" | "leave";

/**
 * One reconcile row — an extracted holding joined to the portfolio, plus the
 * user-editable state (its current match and whether it was discarded). Money is
 * carried in minor units so the impact header stays integer money; `currency` is
 * retained verbatim so a non-EUR row can be flagged rather than silently summed.
 */
export interface ReconcileRow {
  /** Stable id within the batch (`row-0`, `row-1`, …); edits key on it. */
  rowId: string;
  name: string;
  isin?: string;
  /** The mapped instrument, or `null` when the label was unrecognized. */
  instrument: Instrument | null;
  fidelity: HoldingFidelity;
  /** The holding's current value in minor units (`round(value * 100)`). */
  valueMinor: number;
  currency: string;
  declaredCostMinor?: number;
  /** How many extracted movements attribute to this holding (strong or weak key). */
  movementsCount: number;
  /** The current per-row matcher decision (mutated by the reassign helpers). */
  match: RowMatch;
  /** The user discarded this row from the batch ("descartar"); it then `leave`s. */
  excluded: boolean;
  /**
   * The row could not be resolved with confidence — an unmapped instrument, a
   * non-EUR value, or an extractor `uncertain` flag. Informative only: it never
   * blocks (decision #1090), but the surface marks it and the impact excludes it.
   */
  uncertain: boolean;
}

/** The effective decision once exclusion is taken into account. */
export function effectiveDecision(row: ReconcileRow): ReconcileDecision {
  if (row.excluded) return "leave";
  return row.match.decision;
}

/**
 * Whether a row actually writes on apply (PRD #1103 S5 v1 scope). A row writes when
 * it is in the batch, EUR-valued, of an investment instrument, and either creates
 * or updates a match that carries movements to import. A matched holding the
 * document only re-values (no movements) has no dated fact to add over the
 * operation model, so it is honestly left — never a fabricated re-valuation (ADR
 * 0048). Non-investment families are out of the v1 write scope.
 */
export function isRowWritable(row: ReconcileRow): boolean {
  if (row.excluded) return false;
  if (row.currency !== "EUR") return false;
  if (row.instrument === null || !INVESTMENT_INSTRUMENTS.has(row.instrument))
    return false;
  const decision = row.match.decision;
  if (decision === "create") return true;
  if (decision === "update") return row.movementsCount > 0;
  return false;
}

function toMinor(value: number): number {
  return Math.round(value * 100);
}

/**
 * Build the reconcile rows from a validated document and the current portfolio.
 * Each holding becomes a matcher candidate (name + ISIN + mapped instrument); the
 * matcher's per-row decision is the row's initial state. Movement counts are
 * derived per holding via the shared `movementLinksToHolding` key so the surface
 * can show which rows carry real operations.
 */
export function buildReconcileRows(
  document: ExtractedPositionsMovementsDocument,
  portfolio: MatchPortfolioHolding[],
): ReconcileRow[] {
  const candidateRows: MatchCandidateRow[] = document.holdings.map((holding, index) => {
    const instrument = mapReconcileTypeToInstrument(holding.type);
    return {
      rowId: `row-${index}`,
      name: holding.name,
      ...(holding.isin ? { isin: holding.isin } : {}),
      ...(instrument ? { instrument } : {}),
    };
  });
  const matches = matchHoldings(candidateRows, portfolio);

  return document.holdings.map((holding, index) => {
    const instrument = mapReconcileTypeToInstrument(holding.type);
    const movementsCount = document.movements.filter((movement) =>
      movementLinksToHolding(movement, holding),
    ).length;
    const isEur = holding.currency.toUpperCase() === "EUR";
    return {
      rowId: `row-${index}`,
      name: holding.name,
      ...(holding.isin ? { isin: holding.isin } : {}),
      instrument,
      fidelity: holding.fidelity,
      valueMinor: toMinor(holding.value),
      currency: holding.currency.toUpperCase(),
      ...(holding.declaredCost !== undefined
        ? { declaredCostMinor: toMinor(holding.declaredCost) }
        : {}),
      movementsCount,
      match: matches[index]!,
      excluded: false,
      uncertain: holding.uncertain === true || instrument === null || !isEur,
    };
  });
}

/** Replace one row by id with a transformed copy — the immutable edit primitive. */
function mapRow(
  rows: ReconcileRow[],
  rowId: string,
  transform: (row: ReconcileRow) => ReconcileRow,
): ReconcileRow[] {
  return rows.map((row) => (row.rowId === rowId ? transform(row) : row));
}

/** Reassign a row to create a new holding (match → nuevo). */
export function reassignRowToNew(rows: ReconcileRow[], rowId: string): ReconcileRow[] {
  return mapRow(rows, rowId, (row) => ({
    ...row,
    excluded: false,
    match: reassignToNew(row.match),
  }));
}

/**
 * Reassign a row to update a specific candidate (nuevo → match, or match → otro
 * candidato). Delegates the candidate check to the matcher, which throws when the
 * holding is not among the row's candidates.
 */
export function reassignRowToCandidate(
  rows: ReconcileRow[],
  rowId: string,
  holdingId: string,
): ReconcileRow[] {
  return mapRow(rows, rowId, (row) => ({
    ...row,
    excluded: false,
    match: reassignToCandidate(row.match, holdingId),
  }));
}

/** Discard a row from the batch ("descartar"); it is kept, greyed and recoverable. */
export function discardReconcileRow(rows: ReconcileRow[], rowId: string): ReconcileRow[] {
  return mapRow(rows, rowId, (row) => ({ ...row, excluded: true }));
}

/** Bring a discarded row back into the batch. */
export function restoreReconcileRow(rows: ReconcileRow[], rowId: string): ReconcileRow[] {
  return mapRow(rows, rowId, (row) => ({ ...row, excluded: false }));
}

export interface ReconcileSummary {
  create: number;
  update: number;
  leave: number;
  /** Rows that actually write (create + movement-backed update) — the folio's "N". */
  active: number;
  total: number;
}

/**
 * Count the batch by effective decision, with `active` = the rows that truly write
 * ({@link isRowWritable}). A create/update row that is out of the write scope (a
 * non-investment family, a non-EUR value, a movement-less matched holding) counts
 * toward its decision but not toward `active`, so the folio's "N holdings" never
 * overstates what confirm will persist.
 */
export function reconcileSummary(rows: ReconcileRow[]): ReconcileSummary {
  let create = 0;
  let update = 0;
  let leave = 0;
  let active = 0;
  for (const row of rows) {
    const decision = effectiveDecision(row);
    if (decision === "create") create += 1;
    else if (decision === "update") update += 1;
    else leave += 1;
    if (isRowWritable(row)) active += 1;
  }
  return { active, create, leave, total: rows.length, update };
}

export interface ReconcileImpact {
  /** Net worth before, in minor units, or `null` when the read degraded (ADR 0048). */
  beforeMinor: number | null;
  /** `beforeMinor + deltaMinor`, or `null` when `beforeMinor` is unknown. */
  afterMinor: number | null;
  /** The signed sum of the value the included `create` rows add to net worth. */
  deltaMinor: number;
  /**
   * True when the delta is a partial view: an included `update` (its post-merge
   * effect is not computable before applying) or a non-EUR create was left out of
   * the sum. The card says "impacto estimado sobre las altas" rather than overclaim.
   */
  partial: boolean;
}

/**
 * The impact header (antes → después). The delta counts only the value the
 * **created** holdings add to household net worth: a matched `update` reconciles a
 * holding already inside "before", and its post-merge value is not knowable until
 * the apply ripples, so it is honestly excluded and flagged `partial`. Debt
 * creates subtract. Non-EUR and unmapped creates are excluded from the sum (they
 * cannot be converted here without inventing a rate) and also flag `partial`.
 */
export function reconcileImpact(
  rows: ReconcileRow[],
  netWorthBeforeMinor: number | null,
): ReconcileImpact {
  let deltaMinor = 0;
  let partial = false;
  for (const row of rows) {
    const decision = effectiveDecision(row);
    if (decision === "leave") continue;
    // A writable create lands a valued investment holding — it adds to net worth.
    // A writable update reconciles a holding already inside "before"; its post-merge
    // value is not knowable until the ripple, so it is excluded and flags partial.
    // A create that cannot write (out of scope / non-EUR) is likewise excluded.
    if (decision === "create" && isRowWritable(row)) {
      deltaMinor += row.valueMinor;
    } else {
      partial = true;
    }
  }
  return {
    afterMinor: netWorthBeforeMinor === null ? null : netWorthBeforeMinor + deltaMinor,
    beforeMinor: netWorthBeforeMinor,
    deltaMinor,
    partial,
  };
}
