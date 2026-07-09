/**
 * The broker-adapter seam for statement parsing (ADR 0018, issue #480).
 *
 * A {@link StatementBrokerAdapter} captures everything format-specific (delimiter,
 * column mapping + header validation, row parsing incl. date/amount/units/sell
 * detection), a registry maps format ids to adapter instances, and the generic
 * core (`parseStatementWithAdapter` in `./statement-parse`) keeps the
 * format-agnostic rules: row ISIN attribution, all-or-nothing aborts, and the
 * empty-file / unknown-format errors.
 *
 * Adding a format is now a new adapter file + one registry entry, never a new
 * branch in the parser.
 */

import type { ParsedStatementRow, SkippedStatementRow } from "./statement-parse";
import { plantillaAdapter } from "./statement-plantilla-adapter";

type ParsedStatementRowDraft = Omit<ParsedStatementRow, "isin">;
type SkippedStatementRowDraft = Omit<SkippedStatementRow, "isin">;

/**
 * What interpreting one data row produced. The ISIN is reported alongside the
 * outcome (not folded into it) so the core can attach the source ISIN to loaded
 * and skipped rows before portfolio-level routing.
 */
export type StatementRowOutcome =
  | { kind: "row"; row: ParsedStatementRowDraft }
  | { kind: "skipped"; skipped: SkippedStatementRowDraft }
  | { kind: "error"; error: string };

export interface StatementRowResult {
  /** The ISIN this row carried, for grouping/routing, or null. */
  isin: string | null;
  outcome: StatementRowOutcome;
}

/** Header validation result: a format-specific column index, or Spanish errors. */
export type ColumnResolution<C> =
  | { ok: true; columns: C }
  | { ok: false; errors: [string, ...string[]] };

/**
 * Per-format statement behavior. `C` is the format's resolved column index, produced
 * by {@link resolveColumns} and threaded back into {@link parseRow} by the core.
 * Methods (not arrow properties) are deliberate: their parameter bivariance lets a
 * concrete `StatementBrokerAdapter<PlantillaColumns>` live in a registry typed as
 * `StatementBrokerAdapter<unknown>`.
 */
export interface StatementBrokerAdapter<C = unknown> {
  /** Split one raw line into cells (the delimiter is format-specific). */
  splitRow(line: string): string[];
  /** Validate the header row into a column index, or fail with Spanish errors. */
  resolveColumns(header: string[]): ColumnResolution<C>;
  /** Interpret one data row: a loaded row, a skipped row, or a Spanish error. */
  parseRow(input: {
    cells: string[];
    columns: C;
    lineNumber: number;
  }): StatementRowResult;
  /**
   * Whether the resolved header carries an explicit buy/sell signal. Omit when
   * the format's rows are always directional (the common case — signed amounts);
   * return false when the file shape can't distinguish sells, so the UI can warn
   * before anything is confirmed.
   */
  directionResolved?(columns: C): boolean;
}

/**
 * The formats with a configured reader. Worthline's plantilla (#695) is the
 * universal statement format; a new entry extends this union.
 */
export type StatementBroker = "plantilla";

/**
 * The format → adapter registry. Typed as a total `Record<StatementBroker, …>` so a
 * new entry in the {@link StatementBroker} union without an adapter is a type error.
 */
const STATEMENT_BROKER_ADAPTERS: Record<
  StatementBroker,
  StatementBrokerAdapter<unknown>
> = {
  plantilla: plantillaAdapter,
};

/** Whether `value` is a format id the registry can parse (narrows the type). */
export function isStatementBroker(value: string): value is StatementBroker {
  return value in STATEMENT_BROKER_ADAPTERS;
}

/** The adapter for `broker`, or `undefined` when no reader is configured. */
export function getStatementBrokerAdapter(
  broker: string,
): StatementBrokerAdapter<unknown> | undefined {
  return (
    STATEMENT_BROKER_ADAPTERS as Record<
      string,
      StatementBrokerAdapter<unknown> | undefined
    >
  )[broker];
}
