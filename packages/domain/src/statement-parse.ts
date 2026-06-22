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
 * keeps only the broker-agnostic core: the empty-file / unknown-broker guards, the
 * single-ISIN guard, and all-or-nothing aborts (ADR 0010 — a single malformed
 * `Finalizada` row, or a mixed-ISIN file, writes nothing).
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
  /** ISO `YYYY-MM-DD` execution date. */
  dateKey: string;
  /** A negative amount or units loads as a `sell` (abs values); otherwise a buy. */
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
  dateKey: string | null;
  estado: string;
}

export interface ParsedStatement {
  /** The single ISIN the file's rows carry, when present. */
  isin: string | null;
  rows: ParsedStatementRow[];
  skipped: SkippedStatementRow[];
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
 * and interpret each data row, then apply the generic rules — the single-ISIN guard
 * (across rows of EVERY outcome) and all-or-nothing. Exported so the dispatcher can
 * be tested against a fake adapter, independent of the registry.
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
        rows.push(result.outcome.row);
        break;
      case "skipped":
        skipped.push(result.outcome.skipped);
        break;
      case "error":
        errors.push(result.outcome.error);
        break;
    }
  }

  // A statement is per-ISIN (ADR 0018, S4): a file carrying more than one
  // distinct ISIN is a wrong-file slip, not something to graft onto one holding.
  if (isins.size > 1) {
    errors.push(
      `El archivo contiene varios ISIN (${[...isins].join(", ")}); un extracto debe ser de un solo fondo.`,
    );
  }

  // All-or-nothing (ADR 0010): a single malformed Finalizada row, or a mixed-ISIN
  // file, writes nothing.
  if (errors.length > 0) {
    return fail(errors);
  }

  return {
    ok: true,
    value: {
      isin: isins.size === 1 ? [...isins][0]! : null,
      rows,
      skipped,
    },
  };
}

function fail(errors: string[]): { ok: false; errors: [string, ...string[]] } {
  const [first, ...rest] = errors;
  return { errors: [first ?? "El archivo no es válido.", ...rest], ok: false };
}
