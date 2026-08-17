/**
 * The margin with which a **computed** debt balance is compared against a known
 * figure (ADR 0070, #1422). Two callers, one law:
 *
 * - the assistant's reconstruction, measuring a curve rebuilt from ~49 observed
 *   points against the declared balance and the app's own curve;
 * - the amortization-schedule import (#1406), measuring the curve the document's
 *   revisions generate against the balances that same document declares.
 *
 * Both are the same question — «does this reconstruction reproduce a figure we
 * already trust?» — and a curve derived from a bank document can never be
 * expected to reproduce one to the cent. Keeping the constants here means the two
 * surfaces cannot drift into two different definitions of «cuadra».
 */

/** Fraction of the balance accepted as reconstruction noise: 0,1 %. */
const TOLERANCE_FRACTION = 0.001;

/** Floor of the margin: one euro, so a small balance is not held to the cent. */
const TOLERANCE_FLOOR_MINOR = 100;

/**
 * The margin, in minor units, for a figure of `referenceMinor`. Deliberate
 * (#1422): a euro of rounding is not the same thing as 494 € of stale anchor.
 */
export function balanceToleranceMinor(referenceMinor: number): number {
  return Math.max(
    TOLERANCE_FLOOR_MINOR,
    Math.round(Math.abs(referenceMinor) * TOLERANCE_FRACTION),
  );
}

/** Are the two figures within the first one's margin? */
export function balancesAgree(referenceMinor: number, actualMinor: number): boolean {
  return Math.abs(actualMinor - referenceMinor) <= balanceToleranceMinor(referenceMinor);
}
