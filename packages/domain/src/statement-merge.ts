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
 * duplicating.
 *
 * Same-date anomalies (S4): the match key assumes at most one operation per date.
 * A date that carries more than one operation — repeated in the file, or already
 * doubled on the asset — is ambiguous, so we touch neither side and flag it for
 * the preview instead of guessing which row to overwrite.
 */

import type { InvestmentOperation } from "./investment-types";
import { isTransferKind } from "./positions";
import type { ParsedStatementRow } from "./statement-parse";

/** A file row matched to the existing operation it overwrites, by date. */
export interface StatementOverwrite {
  operationId: string;
  row: ParsedStatementRow;
}

/** A date the planner refused to act on because it carries more than one operation. */
export interface StatementAnomaly {
  dateKey: string;
  reason: "duplicate-in-file" | "duplicate-on-asset";
}

export interface StatementMergePlan {
  /** File rows on dates the asset has no operation for. */
  toCreate: ParsedStatementRow[];
  /** File rows whose date matches exactly one existing operation (the file wins). */
  toOverwrite: StatementOverwrite[];
  /**
   * Opening operations replaced by the imported history. Never a half of a
   * traspaso, even one that carries `source: "opening"` (#1479) — see
   * {@link planStatementMerge}.
   */
  toDelete: InvestmentOperation[];
  /** Existing operations the load does not modify — never deleted. */
  untouched: InvestmentOperation[];
  /** Ambiguous dates set aside (neither created nor overwritten), for the preview. */
  anomalies: StatementAnomaly[];
}

export interface StatementMergeOptions {
  replaceOpening?: boolean;
}

/** The date key (`YYYY-MM-DD`) of an operation, tolerating a stored time component. */
function dateKeyOf(operation: InvestmentOperation): string {
  return operation.executedAt.slice(0, 10);
}

function countByKey<T>(items: T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function planStatementMerge(
  rows: ParsedStatementRow[],
  existing: InvestmentOperation[],
  options: StatementMergeOptions = {},
): StatementMergePlan {
  const replaceOpening = options.replaceOpening ?? true;
  // `replaceOpening` exists to drop the SYNTHETIC opening balance an alta minted, so
  // the file's real history can take its place. Half a traspaso is never that, even
  // when it carries `source: "opening"` — which the retyping pass of #1485 leaves on
  // every re-typed alta, and Jorge's book already holds those. Deleting one would
  // orphan its other half, so it stays: a statement speaks buys and sells and its
  // silence about a traspaso is not evidence the traspaso did not happen (ADR 0083).
  // The store refuses such a delete outright; this is what keeps the whole import from
  // hitting that refusal for a row nobody meant to touch.
  const replaceable = (operation: InvestmentOperation): boolean =>
    operation.source === "opening" && !isTransferKind(operation.kind);
  const toDelete = replaceOpening ? existing.filter(replaceable) : [];
  const mergeExisting = replaceOpening
    ? existing.filter((operation) => !replaceable(operation))
    : existing;
  const fileDateCounts = countByKey(rows, (row) => row.dateKey);
  const assetDateCounts = countByKey(mergeExisting, dateKeyOf);
  const existingByDate = new Map<string, InvestmentOperation>();
  for (const operation of mergeExisting) {
    existingByDate.set(dateKeyOf(operation), operation);
  }

  const toCreate: ParsedStatementRow[] = [];
  const toOverwrite: StatementOverwrite[] = [];
  const overwrittenIds = new Set<string>();
  const anomalyDates = new Map<string, StatementAnomaly["reason"]>();

  for (const row of rows) {
    // A date repeated in the file is ambiguous — flag it, act on neither row.
    if ((fileDateCounts.get(row.dateKey) ?? 0) > 1) {
      anomalyDates.set(row.dateKey, "duplicate-in-file");
      continue;
    }

    const assetCount = assetDateCounts.get(row.dateKey) ?? 0;

    // A date the asset already carries more than once is ambiguous — we can't
    // tell which operation the file row should overwrite, so we touch neither.
    if (assetCount > 1) {
      anomalyDates.set(row.dateKey, "duplicate-on-asset");
      continue;
    }

    if (assetCount === 1) {
      const match = existingByDate.get(row.dateKey)!;
      toOverwrite.push({ operationId: match.id, row });
      overwrittenIds.add(match.id);
    } else {
      toCreate.push(row);
    }
  }

  // Every existing operation the load did not overwrite keeps its place — both
  // operations on uncovered dates and those held back by an anomaly. None deleted.
  const untouched = mergeExisting.filter(
    (operation) => !overwrittenIds.has(operation.id),
  );

  const anomalies = [...anomalyDates].map(([dateKey, reason]) => ({ dateKey, reason }));

  return { anomalies, toCreate, toDelete, toOverwrite, untouched };
}
