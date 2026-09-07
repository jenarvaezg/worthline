/**
 * Per-holding statement identity guard (ADR 0018 S4 — #178; generalized by #1748).
 *
 * Pure decision: compare the identifiers the FILE carries to the holding's TYPED
 * identifier pair, so a statement cannot be grafted onto the wrong holding. The
 * web action acts on the verdict (block on `mismatch`, fill the holding on
 * `backfill`, proceed on `match`/`absent`).
 *
 * Since #1748 the comparison happens inside one namespace (`matching-keys`): a
 * plan's `N5394` is guarded against another DGS code, never against an ISIN that
 * merely sits in the same column.
 */

import type { Instrument } from "./instrument-catalog";
import {
  matchKeyValue,
  rowMatchKey,
  securityIdFromMatchKey,
  securityIdMatchKey,
} from "./matching-keys";
import {
  declaredSecurityId,
  instrumentCanCarrySecurityIdKind,
  type SecurityId,
  type StoredSecurityId,
} from "./security-id";
import type { ParsedStatement } from "./statement-parse";

/** The verdict, with what the file carried when it disagrees with the holding. */
export type StatementIdentityGuard =
  | { status: "match" }
  /**
   * Nothing to guard and nothing to write: the file carried no identifier this
   * guard can read, or it carried one the holding could not legally hold (#1453).
   * Both are the same instruction to the caller — load the movements, leave the
   * identity column alone — which is why they share one verdict.
   */
  | { status: "absent" }
  | { status: "backfill"; securityId: SecurityId }
  | { status: "mismatch"; fileIdentifiers: string[] };

/**
 * The holding side of the comparison. Both halves are read: the identifier pair
 * says what it declares (and, through a value with no kind, that the hole is
 * TAKEN), the instrument says which kind it could legally learn.
 */
export interface StatementGuardHolding {
  securityId?: StoredSecurityId | null;
  instrument?: Instrument | null;
}

/** Every namespaced key the file claims, across loaded and skipped rows, in file order. */
function distinctStatementKeys(statement: ParsedStatement): string[] {
  const keys = new Set<string>();
  for (const row of [...statement.rows, ...statement.skipped]) {
    const key = rowMatchKey(row);
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * Per-holding upload is the one-fund case of ADR 0055: parsing may accept a mixed
 * file, but every identifier it carries must be the one this holding declares.
 *
 * An empty holding still learns from a file that carries exactly one identifier —
 * the ADR 0018 backfill, now typed: a plan learns its DGS code and a fund its
 * ISIN. Two guards remain absolute: an identifier already in the hole is never
 * overwritten (a value with no kind included — it is something nobody could read,
 * not an invitation), and nothing is written that the holding's instrument could
 * not carry (#1453).
 */
export function resolvePerHoldingStatementIdentityGuard(
  statement: ParsedStatement,
  holding: StatementGuardHolding,
): StatementIdentityGuard {
  const fileKeys = distinctStatementKeys(statement);
  if (fileKeys.length === 0) {
    return { status: "absent" };
  }

  const declaredKey = securityIdMatchKey(declaredSecurityId(holding.securityId));
  if (declaredKey !== null) {
    return fileKeys.every((key) => key === declaredKey)
      ? { status: "match" }
      : { fileIdentifiers: fileKeys.map(matchKeyValue), status: "mismatch" };
  }

  // An identifier of ANOTHER class occupies the hole just as a declared one does
  // (#1743): filling it would erase what is there with the identity of a paper
  // that is not this holding's.
  if ((holding.securityId?.value ?? "").trim().length > 0) {
    return { fileIdentifiers: fileKeys.map(matchKeyValue), status: "mismatch" };
  }

  if (fileKeys.length !== 1) {
    return { fileIdentifiers: fileKeys.map(matchKeyValue), status: "mismatch" };
  }

  const offered = securityIdFromMatchKey(fileKeys[0]!);
  return offered && instrumentCanCarrySecurityIdKind(holding.instrument, offered.kind)
    ? { securityId: offered, status: "backfill" }
    : { status: "absent" };
}
