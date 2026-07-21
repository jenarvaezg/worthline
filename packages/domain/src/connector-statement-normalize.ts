/**
 * Universal-statement `normalize` step (PRD #1000 S3, ADR 0066).
 *
 * Turns a parsed statement (the "plantilla"/broker template format, #695) into the
 * connector port's {@link NormalizedFact}s — the first stage of `parse → normalized
 * facts → preview/reconcile → confirm/apply`. Pure and DB-free: it only reshapes
 * already-parsed rows, minting each row's stable dedup `key` so that re-importing
 * the same file, or an overlapping second export, applies every underlying
 * operation exactly once (the {@link reconcileFacts} guarantee).
 *
 * The opaque `payload` is the {@link ParsedStatementRow} itself — the application's
 * persister maps it to an investment operation at commit time; the port never
 * inspects it.
 */

import type { NormalizedFact } from "./connector-port";
import type { ParsedStatement, ParsedStatementRow } from "./statement-parse";

/** The opaque payload a statement fact carries: the parsed broker row verbatim. */
export type StatementFactPayload = ParsedStatementRow;

/**
 * Mint a stable, content-derived dedup key for one statement row. Two observations
 * of the same underlying operation — a re-uploaded file, an overlapping export
 * window — derive the SAME key, so the port applies the operation once. Built from
 * the row's own stable identifiers (never ingestion time): its instrument key, the
 * execution date (and optional intraday timestamp for same-day ordering), the
 * direction, and the reconstructed units/price.
 *
 * `isin` is the primary grouping key; a row that carries none (a name-only
 * plantilla row) falls back to its display name so distinct instruments on the same
 * day do not collide.
 */
export function statementRowKey(row: ParsedStatementRow): string {
  const instrument = row.isin ?? (row.name ? `name:${row.name}` : "∅");
  return [
    instrument,
    row.dateKey,
    row.occurredAt ?? "",
    row.kind,
    row.units,
    row.pricePerUnit,
    row.currency,
  ].join("|");
}

/**
 * Normalize a parsed statement's loaded rows into port {@link NormalizedFact}s, in
 * file order. Skipped rows (no direction, unparseable) are not facts — they never
 * reach the port. Each fact's `dateKey` is the row's execution date, which drives
 * the ripple floor when committed.
 *
 * Normalize maps EVERY loaded row: per the port's staging, user selection and
 * per-row exclusion (the "coincide / nuevo / ignorado" curation) are the
 * reconciliation *surface*'s job (PRD #1000 S4, #890), not this step's. Dropping a
 * row here would hide it from that surface.
 */
export function statementFactsFromStatement(
  statement: ParsedStatement,
): NormalizedFact<StatementFactPayload>[] {
  return statement.rows.map((row) => ({
    key: statementRowKey(row),
    dateKey: row.dateKey,
    payload: row,
  }));
}
