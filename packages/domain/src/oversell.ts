import {
  compareUnits,
  type DecimalString,
  formatUnits,
  scaleDecimal,
  subtractUnits,
} from "./decimal";

/**
 * Dust vs fat-finger for a sell past what is held (#1443).
 *
 * Dust is the broker-rounding case (Jorge's 32 against 31,999): the excess is
 * at most 1 unit OR at most 1 % of what is held. Anything larger is a likely
 * mistype. `held === 0` is always a fat-finger — there is no position to round.
 *
 * This is copy and a confirm checkbox, never a write block: both kinds persist
 * the typed units once confirmed. The read-side clamp in `derivePosition` is
 * unchanged.
 */
export type OversellExcessKind = "dust" | "fat_finger";

export function classifyOversellExcess(
  held: DecimalString,
  sold: DecimalString,
): OversellExcessKind {
  if (compareUnits(held, "0") === 0) {
    return "fat_finger";
  }

  const excess = subtractUnits(sold, held);
  const atMostOneUnit = compareUnits(excess, "1") <= 0;
  // excess ≤ 1% of held  ⇔  100 × excess ≤ held
  const atMostOnePercent = compareUnits(scaleDecimal(excess, 100, 8), held) <= 0;

  return atMostOneUnit || atMostOnePercent ? "dust" : "fat_finger";
}

/**
 * The confirm-band copy for a sell past `held`. Numbers use the same units
 * voice as the rest of the ficha (`formatUnits`).
 */
export function oversellConfirmMessage(held: DecimalString, sold: DecimalString): string {
  const heldLabel = formatUnits(held);
  const soldLabel = formatUnits(sold);

  if (classifyOversellExcess(held, sold) === "dust") {
    return `Tienes ${heldLabel}; vas a vender ${soldLabel}. Si es el redondeo del bróker, confirma. Si no, corrige las unidades.`;
  }

  return `Tienes ${heldLabel}; vas a vender ${soldLabel}. Eso supera con mucho la posición. Si no es un dedazo, confirma.`;
}
