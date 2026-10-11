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
