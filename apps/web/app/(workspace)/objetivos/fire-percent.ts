/**
 * How the FIRE panel writes a percentage — one place, because the panel prints
 * several and they must look like one voice (#1426).
 *
 * Three surfaces asked for the same es-ES one-decimal percentage: the rent-derived
 * rate (#1448), the funded/coast progress figures and the assumptions fold. Written
 * three times they were three formatters one rounding change away from disagreeing,
 * on a screen whose whole point is that its figures add up.
 *
 * Two precisions, deliberately: one decimal for a figure the reader compares
 * («68,5 % financiado», «3,5 % de retirada»), two for the weights and contributions
 * of the return mix, whose rows have to be seen adding up to the rate.
 */

const oneDecimal = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

const cleanPercent = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

const twoDecimals = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/** A percentage VALUE (68.45, not 0.6845) as es-ES text: `68,5 %`. */
export function formatFirePercent(percent: number): string {
  return `${oneDecimal.format(percent)} %`;
}

/** A decimal RATE (0.035) as an es-ES percentage: `3,5 %`. */
export function formatRatePercent(rate: number): string {
  return formatFirePercent(rate * 100);
}

/**
 * A spending multiplier as a percentage (`0.7` → `70 %`): no forced decimal, because
 * «Lean es tu gasto al 70 %» is a definition, not a measurement. An unusual multiple
 * keeps its decimal (`0.725` → `72,5 %`).
 */
export function formatMultiplierPercent(multiplier: number): string {
  return `${cleanPercent.format(multiplier * 100)} %`;
}

/**
 * A rate difference in percentage POINTS: `0.015` → `1,5 puntos`. Points, not percent,
 * because «la base más 1,5 %» would read as 1,5 % OF the base instead of 1,5 points
 * added to it.
 */
export function formatRatePoints(shift: number): string {
  const value = shift * 100;
  return `${cleanPercent.format(value)} ${value === 1 ? "punto" : "puntos"}`;
}

/**
 * A weight or a contribution of the return mix, as a fraction (0.2793 → `27,93 %`).
 * Two decimals so the printed rows visibly add up to the printed rate.
 */
export function formatFineFirePercent(fraction: number): string {
  return `${twoDecimals.format(fraction * 100)} %`;
}
