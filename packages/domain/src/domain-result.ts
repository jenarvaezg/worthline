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
  | {
      /** No ECB rate covers the execution date, so the apunte has no honest EUR figure (#1401). */
      code: "operation_currency_missing_rate";
      currency: string;
      executedAt: string;
    }
  | { code: "investment_manual_valuation_rejected" }
  | { code: "connected_manual_valuation_rejected" }
  // The refusals of the traspaso gate (#1479). All six are figures a user typed, so
  // they are data rather than throws — unlike the row-level column rules of ADR 0082,
  // which no form can reach.
  | { code: "transfer_same_holding" }
  | { code: "transfer_amount_not_positive" }
  | { code: "transfer_price_not_positive"; side: "origin" | "destination" }
  | { code: "transfer_origin_has_no_units" }
  | {
      /** The two holdings' ledgers are in different currencies, so no cost can travel. */
      code: "transfer_currency_mismatch";
      origin: string;
      destination: string;
    }
  | {
      /** The stated importe divides into more participaciones than the origin holds. */
      code: "transfer_units_exceed_position";
      unitsRequested: string;
      unitsHeld: string;
    }
  | { code: "value_update_investment_holding" }
  | { code: "debt_balance_governed_by_curve" }
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
