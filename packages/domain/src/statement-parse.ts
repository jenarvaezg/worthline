/**
 * Broker statement parser (ADR 0018, S1 — the walking-skeleton tracer; #480 — the
 * broker-adapter seam).
 *
 * A **statement** is a broker's exported order file fed against one investment to
 * populate its **operations** — neither an Import (ADR 0010 full-workspace
 * replace) nor a connected source (ADR 0016 live mirror). This module is the pure
 * gate between the untrusted CSV text and the operations it becomes: it returns
 * parsed rows + skipped rows, or a list of Spanish errors (they surface in the
 * UI). It performs NO IO and reads no DB.
 *
 * Since #480 the broker-specific work (delimiter, columns, dates, amounts, sells)
 * lives in a {@link StatementBrokerAdapter} selected from the registry; this module
 * keeps only the broker-agnostic core: the empty-file / unknown-broker guards and
 * all-or-nothing aborts (ADR 0010 — a single malformed `Finalizada` row writes
 * nothing). ADR 0055 moves mixed-ISIN routing out of parsing and into the statement
 * import planner, so rows preserve their own ISIN instead of being rejected here.
 */

import type { DecimalString } from "./decimal";
import type { OperationKind } from "./investment-types";
import type { CurrencyCode } from "./money";
import {
  getStatementBrokerAdapter,
  type StatementBroker,
  type StatementBrokerAdapter,
} from "./statement-broker-adapter";

export type { StatementBroker };

/** One executed order from the statement, ready to become an operation. */
export interface ParsedStatementRow {
  /** The ISIN carried by this broker row, when present. */
  isin: string | null;
  /** ISO `YYYY-MM-DD` execution date. */
  dateKey: string;
  /**
   * From the broker's direction signal (`Tipo de operación` when the export
   * carries it; else a negative amount/units); stored with absolute values.
   */
  kind: OperationKind;
  units: DecimalString;
  /** Reconstructed NAV: amount ÷ units, at high precision. */
  pricePerUnit: DecimalString;
  /** Always 0 — a no-fee fund subscription reconciles exactly to the amount. */
  feesMinor: number;
  currency: CurrencyCode;
}

/** A row that did not load, with the `Estado` that caused it to be skipped. */
export interface SkippedStatementRow {
  isin: string | null;
  dateKey: string | null;
  estado: string;
}

export interface ParsedStatement {
  /** The single ISIN the file's rows carry, when there is exactly one. */
  isin: string | null;
  /** Distinct non-empty ISINs seen across loaded and skipped rows, in file order. */
  isins: string[];
  rows: ParsedStatementRow[];
  skipped: SkippedStatementRow[];
  /**
   * False when the file shape carries no explicit buy/sell signal (e.g.
   * MyInvestor's reduced export, where every row loads as a buy) — the UI warns
   * before confirm so a statement with sells isn't silently mis-imported.
   */
  directionResolved: boolean;
}

export type ParseStatementResult =
  | { ok: true; value: ParsedStatement }
  | { ok: false; errors: [string, ...string[]] };

/**
 * Parse a statement for `broker`. Dispatches through the adapter registry: an
 * unknown broker fails loudly (instead of silently mis-parsing) with the Spanish
 * message, and everything else delegates to {@link parseStatementWithAdapter}.
 */
export function parseStatement(
  rawText: string,
  broker: StatementBroker,
): ParseStatementResult {
  const adapter = getStatementBrokerAdapter(broker);
  if (!adapter) {
    return fail([`No hay un lector configurado para el bróker "${String(broker)}".`]);
  }
  return parseStatementWithAdapter(rawText, adapter);
}

/**
 * The broker-agnostic core: split + trim lines, let the adapter validate the header
 * and interpret each data row, then apply the generic all-or-nothing rule. Exported
 * so the dispatcher can be tested against a fake adapter, independent of the
 * registry.
 *
 * @internal — prefer {@link parseStatement} (which enforces the {@link StatementBroker}
 * registry guard); this entry point accepts an arbitrary adapter, for tests.
 */
export function parseStatementWithAdapter<C>(
  rawText: string,
  adapter: StatementBrokerAdapter<C>,
): ParseStatementResult {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return fail(["El archivo está vacío."]);
  }

  const resolved = adapter.resolveColumns(adapter.splitRow(lines[0]!));
  if (!resolved.ok) {
    return { errors: resolved.errors, ok: false };
  }

  const errors: string[] = [];
  const rows: ParsedStatementRow[] = [];
  const skipped: SkippedStatementRow[] = [];
  const isins = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const result = adapter.parseRow({
      cells: adapter.splitRow(lines[i]!),
      columns: resolved.columns,
      lineNumber: i + 1,
    });

    if (result.isin) isins.add(result.isin);

    switch (result.outcome.kind) {
      case "row":
        rows.push({ ...result.outcome.row, isin: result.isin });
        break;
      case "skipped":
        skipped.push({ ...result.outcome.skipped, isin: result.isin });
        break;
      case "error":
        errors.push(result.outcome.error);
        break;
    }
  }

  // All-or-nothing (ADR 0010): a single malformed Finalizada row writes nothing.
  if (errors.length > 0) {
    return fail(errors);
  }

  const distinctIsins = [...isins];

  return {
    ok: true,
    value: {
      directionResolved: adapter.directionResolved?.(resolved.columns) ?? true,
      isin: distinctIsins.length === 1 ? distinctIsins[0]! : null,
      isins: distinctIsins,
      rows,
      skipped,
    },
  };
}

function fail(errors: string[]): { ok: false; errors: [string, ...string[]] } {
  const [first, ...rest] = errors;
  return { errors: [first ?? "El archivo no es válido.", ...rest], ok: false };
}
