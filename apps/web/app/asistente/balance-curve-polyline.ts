export function balanceCurvePolyline(
  curve: ReadonlyArray<{ balanceMinor: number }>,
): string {
  if (curve.length === 0) return "";
  const values = curve.map((point) => point.balanceMinor);
  const min = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - min);
  return curve
    .map((point, index) => {
      const x = curve.length === 1 ? 50 : (index / (curve.length - 1)) * 100;
      const y = 92 - ((point.balanceMinor - min) / span) * 84;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}
