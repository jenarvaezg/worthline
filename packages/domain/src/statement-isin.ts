/**
 * Broker statement ISIN guard (ADR 0018, S4 — #178).
 *
 * Pure decision: compare the file's ISIN to the selected asset's recorded ISIN
 * so a statement can't be grafted onto the wrong holding. The web action acts on
 * the verdict (block on `mismatch`, backfill the asset on `backfill`, proceed on
 * `match`/`absent`). Comparison is case- and whitespace-insensitive.
 *
 * `absent` means the file carried no ISIN (the parser rejects a mixed-ISIN file
 * upstream, so this is the no-ISIN case): there is nothing to guard, so the load
 * proceeds without touching the asset's ISIN.
 */

export type StatementIsinGuard =
  | { status: "match" }
  | { status: "mismatch" }
  | { status: "backfill"; isin: string }
  | { status: "absent" };

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
