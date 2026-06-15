/**
 * Broker statement merge-by-date planner (ADR 0018, S2 — #175).
 *
 * Turns the parsed statement rows plus the asset's existing **operations** into a
 * write plan WITHOUT touching the DB — a pure function, so the upsert semantics
 * are tested in isolation and the web action just applies the plan.
 *
 * The file is authoritative for the dates it covers, not for the whole asset
 * ("upsert, not mirror"):
 *   - a file row whose date matches an existing operation → **overwrite** it (the
 *     file wins, even when a true re-import is identical);
 *   - a file row with no matching date → **create** it;
 *   - an existing operation whose date is absent from the file → **untouched**
 *     (never deleted).
 *
 * The match key is the **date alone** (ADR 0018): quantity was deliberately
 * rejected, so a hand-typed approximation still overwrites rather than
 * duplicating. The same-date anomaly handling (more than one operation on a
 * single date) is layered on in Slice 4.
 */

import type { InvestmentOperation } from "./investment-types";
import type { ParsedStatementRow } from "./statement-parse";

/** A file row matched to the existing operation it overwrites, by date. */
export interface StatementOverwrite {
  operationId: string;
  row: ParsedStatementRow;
}

export interface StatementMergePlan {
  /** File rows on dates the asset has no operation for. */
  toCreate: ParsedStatementRow[];
  /** File rows whose date matches an existing operation (the file wins). */
  toOverwrite: StatementOverwrite[];
  /** Existing operations on dates the file does not cover — never deleted. */
  untouched: InvestmentOperation[];
}

/** The date key (`YYYY-MM-DD`) of an operation, tolerating a stored time component. */
function dateKeyOf(operation: InvestmentOperation): string {
  return operation.executedAt.slice(0, 10);
}

export function planStatementMerge(
  rows: ParsedStatementRow[],
  existing: InvestmentOperation[],
): StatementMergePlan {
  const existingByDate = new Map<string, InvestmentOperation>();
  for (const operation of existing) {
    existingByDate.set(dateKeyOf(operation), operation);
  }

  const toCreate: ParsedStatementRow[] = [];
  const toOverwrite: StatementOverwrite[] = [];
  const coveredDates = new Set<string>();

  for (const row of rows) {
    coveredDates.add(row.dateKey);
    const match = existingByDate.get(row.dateKey);
    if (match) {
      toOverwrite.push({ operationId: match.id, row });
    } else {
      toCreate.push(row);
    }
  }

  // An existing operation the file never names keeps its place untouched.
  const untouched = existing.filter(
    (operation) => !coveredDates.has(dateKeyOf(operation)),
  );

  return { toCreate, toOverwrite, untouched };
}
