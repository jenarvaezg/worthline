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
  ExtractedMovement,
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
 * One movement the document attributes to a row — the EVIDENCE of what the apply
 * will write on that holding (#1373). Before this the row carried only a count, so
 * a card could say «con movimientos» while showing neither the date, the type, the
 * participaciones, the price nor the amount: exactly the four facts that would have
 * made a wrong target and a `+0 €` header obvious at a glance.
 *
 * The shape mirrors `operationsFromMovements` (the confirm's writer) on purpose:
 * `signedAmountMinor` is signed BY KIND (a venta subtracts) rather than by the
 * document's sign, and `unitPrice` is the same `amount / units` division the apply
 * persists as `pricePerUnit`. What is printed is therefore what is written.
 */
export interface ReconcileRowMovement {
  /** The document's own day, `YYYY-MM-DD`. */
  date: string;
  kind: ExtractedMovement["kind"];
  /** Minor units, signed by kind: buy/contribution add, sell subtracts. */
  signedAmountMinor: number;
  currency: string;
  /** Participaciones, only when the document reports a quantity. */
  units?: number;
  /** `amount / units` when both are known — the unit price the apply writes. */
  unitPrice?: number;
}

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
  /**
   * The extracted movements that attribute to this holding (strong or weak key), in
   * document order — what the row prints and what the apply writes.
   */
  movements: ReconcileRowMovement[];
  /**
   * The signed sum of the EUR movements above, in minor units. Carried ON the row
   * (#1373) so the impact header adds a figure computed once, next to the evidence
   * it comes from, instead of the card re-deriving money in the view.
   */
  movementsDeltaMinor: number;
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
  if (decision === "update") return row.movements.length > 0;
  return false;
}

function toMinor(value: number): number {
  return Math.round(value * 100);
}

/**
 * Project one extracted movement onto the row. The sign comes from the KIND, never
 * from the document's own sign: a sheet may state a venta as `-1.000` or as `1.000`
 * and both mean the same withdrawal, so `Math.abs` + kind is the only reading that
 * cannot double-negate one of the two.
 */
function toRowMovement(movement: ExtractedMovement): ReconcileRowMovement {
  const amount = Math.abs(movement.amount);
  const magnitudeMinor = toMinor(amount);
  const units =
    typeof movement.units === "number" && movement.units > 0
      ? Math.abs(movement.units)
      : undefined;
  return {
    currency: movement.currency.toUpperCase(),
    date: movement.date,
    kind: movement.kind,
    signedAmountMinor: movement.kind === "sell" ? -magnitudeMinor : magnitudeMinor,
    ...(units === undefined ? {} : { unitPrice: amount / units, units }),
  };
}

/** Whether a movement's currency is one the reconcile can sum and write (EUR-only v1). */
function isSummableMovement(movement: ReconcileRowMovement): boolean {
  return movement.currency === "EUR";
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
    const movements = document.movements
      .filter((movement) => movementLinksToHolding(movement, holding))
      .map(toRowMovement);
    const movementsDeltaMinor = movements
      .filter(isSummableMovement)
      .reduce((sum, movement) => sum + movement.signedAmountMinor, 0);
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
      movements,
      movementsDeltaMinor,
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
  /** The signed sum of what the included rows add to net worth. */
  deltaMinor: number;
  /**
   * True when something the batch WILL write is not in the sum: a row out of the v1
   * write scope, a non-EUR create, an update the document only re-values, or a
   * linked movement in another currency. The caption then says «estimado» instead of
   * presenting a partial figure as the whole impact.
   */
  partial: boolean;
  /** A created holding's value is part of the sum. */
  includesCreates: boolean;
  /** A movement-backed update's signed movement sum is part of the sum. */
  includesMovements: boolean;
}

/**
 * The impact header (antes → después).
 *
 * A `create` contributes the value the document declares for it. A movement-backed
 * `update` contributes the SIGNED SUM OF ITS MOVEMENTS (#1373): before this, every
 * update was excluded on the grounds that its post-merge value «is not knowable
 * until the ripple», which turned a document stating a 125 € aportación into a
 * header reading `+0 €`. The part that was genuinely unknowable is the REVALUATION
 * of the resulting units — not the cash the document says went in, which is exactly
 * what the confirm writes as operations. So the knowable half is summed and the
 * caption keeps saying the ripple can still move the figure.
 *
 * An update the document only re-values still contributes nothing (there is no
 * dated fact to add — ADR 0048) and flags `partial`, as do out-of-scope rows,
 * non-EUR creates and movements in a currency this lane cannot convert.
 */
export function reconcileImpact(
  rows: ReconcileRow[],
  netWorthBeforeMinor: number | null,
): ReconcileImpact {
  let deltaMinor = 0;
  let partial = false;
  let includesCreates = false;
  let includesMovements = false;
  for (const row of rows) {
    const decision = effectiveDecision(row);
    if (decision === "leave") continue;
    // A create that cannot write (out of scope / non-EUR) is excluded, as is an
    // update with no movements to add: neither has a knowable, dated effect here.
    if (!isRowWritable(row)) {
      partial = true;
      continue;
    }
    if (decision === "create") {
      deltaMinor += row.valueMinor;
      includesCreates = true;
      continue;
    }
    const summable = row.movements.filter(isSummableMovement);
    if (summable.length === 0) {
      // Movement-backed by the write scope's rule, but nothing summable in euros.
      partial = true;
      continue;
    }
    deltaMinor += row.movementsDeltaMinor;
    includesMovements = true;
    if (summable.length < row.movements.length) partial = true;
  }
  return {
    afterMinor: netWorthBeforeMinor === null ? null : netWorthBeforeMinor + deltaMinor,
    beforeMinor: netWorthBeforeMinor,
    deltaMinor,
    includesCreates,
    includesMovements,
    partial,
  };
}
