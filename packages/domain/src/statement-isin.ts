/**
 * Broker statement ISIN guard (ADR 0018, S4 — #178).
 *
 * Pure decision: compare the file's ISIN to the selected asset's recorded ISIN
 * so a statement can't be grafted onto the wrong holding. The web action acts on
 * the verdict (block on `mismatch`, backfill the asset on `backfill`, proceed on
 * `match`/`absent`). Comparison is case- and whitespace-insensitive.
 *
 * `absent` means the file carried no ISIN: there is nothing to guard, so the load
 * proceeds without touching the asset's ISIN. The per-holding guard below handles
 * mixed-ISIN statements as the ADR 0055 one-fund case.
 */

import type { ParsedStatement } from "./statement-parse";

export type StatementIsinGuard =
  | { status: "match" }
  | { status: "mismatch" }
  | { status: "backfill"; isin: string }
  | { status: "absent" };

export type PerHoldingStatementIsinGuard =
  | Exclude<StatementIsinGuard, { status: "mismatch" }>
  | { status: "mismatch"; fileIsins: string[] };

function normalize(isin: string | null | undefined): string | null {
  const trimmed = (isin ?? "").trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export function resolveStatementIsinGuard(
  fileIsin: string | null,
  assetIsin: string | null | undefined,
): StatementIsinGuard {
  const file = normalize(fileIsin);
  const asset = normalize(assetIsin);

  if (file === null) {
    return { status: "absent" };
  }

  if (asset === null) {
    // Backfill with the file's value as it was written (normalized to upper).
    return { isin: file, status: "backfill" };
  }

  return file === asset ? { status: "match" } : { status: "mismatch" };
}

function distinctStatementIsins(statement: ParsedStatement): string[] {
  const isins = new Set<string>();

  for (const row of statement.rows) {
    const isin = normalize(row.isin);
    if (isin) isins.add(isin);
  }

  for (const row of statement.skipped) {
    const isin = normalize(row.isin);
    if (isin) isins.add(isin);
  }

  return [...isins];
}

/**
 * Per-holding upload is now the one-fund case of ADR 0055: parsing may accept a
 * mixed file, but every row carrying an ISIN must match the selected holding. An
 * empty holding still backfills from a single file ISIN, preserving the ADR 0018
 * guard behavior.
 */
export function resolvePerHoldingStatementIsinGuard(
  statement: ParsedStatement,
  assetIsin: string | null | undefined,
): PerHoldingStatementIsinGuard {
  const fileIsins = distinctStatementIsins(statement);
  const asset = normalize(assetIsin);

  if (fileIsins.length === 0) {
    return { status: "absent" };
  }

  if (asset === null) {
    return fileIsins.length === 1
      ? { isin: fileIsins[0]!, status: "backfill" }
      : { fileIsins, status: "mismatch" };
  }

  return fileIsins.every((isin) => isin === asset)
    ? { status: "match" }
    : { fileIsins, status: "mismatch" };
}
