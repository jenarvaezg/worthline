/**
 * Invented figures for the MyInvestor fixtures (#1887): each distinct real amount gets
 * its own random fake, derived from the secret, so the same real value always gives the
 * same fake (the equalities survive: a scheduled contribution and its order, the two legs
 * of a switch, a hold and its order) while no common factor links fakes to reals.
 *
 * The fake stays in the same order of magnitude (×0.55 to ×1.75) and its cents never end
 * in 0 or 5, so a round real amount does not stay round. Share counts get their own
 * random fake at the decimals the API uses for that instrument.
 */
import { createHmac } from "node:crypto";

import { canonicalDecimal, multiplyDecimal, roundDecimal } from "./decimal";

export interface FigurePair {
  readonly real: string;
  readonly fake: string;
}

export interface FigureMap {
  /** The fake of an amount, to the cent. */
  amount(real: string): string;
  /** The fake of a share count, to `decimals` places and never below one unit. */
  quantity(real: string, decimals: number): string;
  /** Every amount mapped so far, for the common-factor check. */
  pairs(): readonly FigurePair[];
}

export interface Forbidden {
  /** Fakes an amount must not take (the real amounts of the capture). */
  readonly amounts?: ReadonlySet<string>;
  /** Fakes a share count must not take. */
  readonly quantities?: ReadonlySet<string>;
}

const looksRound = (fake: string) => /\.\d?[05]$|^-?\d+$/.test(fake);

export function createFigureMap(secret: string, forbidden: Forbidden = {}): FigureMap {
  const multiplier = (kind: string, real: string, attempt: number) => {
    const bytes = createHmac("sha256", secret)
      .update(`${kind}\u0000${real}\u0000${attempt}`)
      .digest();
    // ×0.55 to ×1.75, five decimals, widened a little on each retry.
    const hundredThousandths =
      55_000 + (bytes.readUInt32BE(0) % (120_000 + attempt * 4_000));
    const whole = Math.floor(hundredThousandths / 100_000);
    return `${whole}.${String(hundredThousandths % 100_000).padStart(5, "0")}`;
  };

  const amounts = new Map<string, string>();
  const used = new Set<string>();
  const quantities = new Map<string, string>();

  return {
    amount(real) {
      const key = canonicalDecimal(real);
      if (key === "0") return "0";
      const known = amounts.get(key);
      if (known !== undefined) return known;
      const negative = key.startsWith("-");
      const magnitude = negative ? key.slice(1) : key;
      for (let attempt = 0; attempt < 500; attempt++) {
        const fake = roundDecimal(
          multiplyDecimal(magnitude, multiplier("amount", key, attempt)),
          2,
        );
        if (fake === "0" || fake === magnitude || looksRound(fake) || used.has(fake))
          continue;
        const signed = negative ? `-${fake}` : fake;
        if (forbidden.amounts?.has(signed)) continue;
        amounts.set(key, signed);
        used.add(fake);
        return signed;
      }
      throw new Error("No se encuentra un importe falso libre");
    },

    quantity(real, decimals) {
      const key = canonicalDecimal(real);
      if (key === "0") return "0";
      const memo = `${decimals}\u0000${key}`;
      const known = quantities.get(memo);
      if (known !== undefined) return known;
      const unit = decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
      for (let attempt = 0; attempt < 500; attempt++) {
        let fake = roundDecimal(
          multiplyDecimal(key, multiplier("quantity", key, attempt)),
          decimals,
        );
        if (fake === "0") fake = unit;
        if (fake === key && attempt < 50) continue;
        if (forbidden.quantities?.has(fake)) continue;
        quantities.set(memo, fake);
        return fake;
      }
      throw new Error("No se encuentra una cantidad falsa libre");
    },

    pairs: () => [...amounts].map(([real, fake]) => ({ real, fake })),
  };
}

/**
 * True when the fakes look like the reals times one factor: with three pairs or more,
 * the ratios fake/real barely spread, or most of them repeat.
 */
export function hasCommonFactor(pairs: readonly FigurePair[]): boolean {
  // One ratio per distinct real amount: an amount that repeats keeps its fake on purpose.
  const byReal = new Map<string, string>();
  for (const { real, fake } of pairs) if (Number(real) !== 0) byReal.set(real, fake);
  const ratios = [...byReal].map(([real, fake]) => Number(fake) / Number(real));
  if (ratios.length < 3) return false;
  const spread = Math.max(...ratios) / Math.min(...ratios);
  const counts = new Map<string, number>();
  for (const ratio of ratios) {
    const key = ratio.toFixed(3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const commonest = Math.max(...counts.values()) / ratios.length;
  return spread < 1.15 || commonest > 0.5;
}
