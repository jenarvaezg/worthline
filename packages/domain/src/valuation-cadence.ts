import Big from "big.js";

/**
 * Valuation cadence (ADR 0031): how a MODELED holding's value moves between its
 * own event dates. `step` — the default — holds the most recent past event's
 * value flat until the next event, the honest model since nothing is observed
 * between events (a mortgage owes the same principal until the next cuota, a
 * house is repriced nothing on a Tuesday). `interpolated` is the per-holding
 * opt-in that draws a smooth line between events: linear by calendar day for
 * balances, continuous daily compounding for appreciation.
 *
 * Orthogonal to the valuation method (ADR 0014): it only qualifies the modeled
 * methods (`amortized`, `anchored`-revolving, `appreciating`). Market-priced
 * holdings (`stored` / `derived`) ignore it — their daily movement is a real
 * observed price, not interpolation — and on `informal` debt `step` is the only
 * behaviour (its "no interpolation, ever" stands). `null` reads as `step`.
 */
export type ValuationCadence = "step" | "interpolated";

/** A null/absent cadence reads as the default `step`. */
export function cadenceOrDefault(
  cadence: ValuationCadence | null | undefined,
): ValuationCadence {
  return cadence === "interpolated" ? "interpolated" : "step";
}

export interface InterpolateOrStepInput {
  /** Value at the lower (most recent past) event point, minor units. */
  lower: Big;
  /** Value at the upper (next) event point, minor units. */
  upper: Big;
  /** Days between the two bracketing event dates (the span). */
  span: number;
  /** Days from the lower event date to the target date. */
  offset: number;
  /** step → the lower value, flat; interpolated → linear lower→upper. */
  cadence: ValuationCadence;
}

/**
 * The value on a target date that falls between two bracketing event points,
 * read either as a right-continuous STEP (the lower event's value, flat until
 * the next event) or by linear INTERPOLATION across the calendar-day span.
 *
 * `step` returns `lower` regardless of offset/span. `interpolated` returns
 * `lower + (upper − lower) × offset/span`. A zero-length span (the two event
 * dates coincide) has no fraction to compute, so both cadences return `lower`.
 *
 * Pure and unit-agnostic — it operates on big.js values and the caller rounds at
 * the edge. This is the one place the amortizable and revolving balance engines
 * (and any future modeled balance) decide step-vs-interpolate between events.
 */
export function interpolateOrStep(input: InterpolateOrStepInput): Big {
  const { lower, upper, span, offset, cadence } = input;
  if (cadence === "step") {
    return lower;
  }
  const fraction = span === 0 ? new Big(0) : new Big(offset).div(span);
  return lower.plus(upper.minus(lower).times(fraction));
}
