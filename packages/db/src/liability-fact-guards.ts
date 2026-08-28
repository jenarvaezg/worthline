/**
 * The field shapes a dated fact of a debt validates at its own write boundary:
 * an ISO date, a decimal-string rate, and money as integer minor units. They
 * live here, outside the fact modules, because four of the five families (plan,
 * rate revision, early repayment, anchor) assert the same shapes and none of
 * them owns the rule (#1604).
 *
 * The fifth — the re-baseline — asserts none of them: it hands its dates and its
 * rate straight to `deriveCurrentStateAmortizationPlan`, so the domain is what
 * rejects a malformed one. That asymmetry predates the split and is left as it
 * was; it is written down here so it stays visible.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format, got "${value}".`);
  }
}

export function assertDecimalString(value: string, label: string): void {
  if (!DECIMAL_STRING.test(value)) {
    throw new Error(`${label} must be a decimal string (e.g. "0.025"), got "${value}".`);
  }
}

/** Money crosses the store boundary as integer minor units, never as a float. */
export function assertMinorUnits(value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error("Money must be stored as integer minor units.");
  }
}
