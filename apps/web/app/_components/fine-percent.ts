/**
 * A fraction as an es-ES percentage with two decimals (`0.2793` → `27,93 %`).
 *
 * Shared because two surfaces need the same precision for different reasons and
 * must not drift apart: the FIRE return mix, whose rows have to be seen adding up
 * to the printed rate (#1426), and the portfolio TER (#1717), which lives in
 * hundredths of a percent — a whole-percent formatter would print every index
 * fund as «0 %».
 */
const twoDecimals = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

export function formatFinePercent(fraction: number): string {
  return `${twoDecimals.format(fraction * 100)} %`;
}

const declaredDecimals = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
});

/**
 * A rate the user DECLARED — an interest rate, an appreciation rate — read back on
 * display: two decimals like {@link formatFinePercent}, but never rounding away one
 * the user typed. A loan at Euríbor plus a spread is 2,875 %, and printing «2,88 %»
 * beside a field that holds 2.875 would be a second opinion on the same contract.
 */
export function formatDeclaredRatePercent(fraction: number): string {
  return `${declaredDecimals.format(fraction * 100)} %`;
}
