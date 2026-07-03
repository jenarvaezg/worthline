/**
 * A rule violation reported by a domain constructor — carries a stable
 * machine-readable `code` plus context fields that callers can use to format
 * a user-facing message without re-deriving the rule.
 *
 * Discriminated by `code` so callers can switch on it exhaustively.
 */
export type DomainViolation =
  | { code: "ownership_split_invalid"; totalBps: number }
  | { code: "operation_units_not_positive" }
  | { code: "operation_price_negative" }
  | { code: "operation_fees_negative" }
  | { code: "investment_manual_valuation_rejected" }
  | { code: "value_update_investment_holding" }
  | { code: "duplicate_primary_residence"; existingName: string };

/**
 * Discriminated result returned by safe domain constructors.
 * `{ ok: true, value }` carries the created entity.
 * `{ ok: false, violations }` carries a non-empty list of violations with
 * stable machine-readable codes — no exception is thrown.
 *
 * Programmer-error paths (unknown member id, non-integer bps, invalid
 * currency) still throw — only rule violations become data.
 */
export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: [DomainViolation, ...DomainViolation[]] };
