/**
 * Metal-value resolver (PRD #160 / #163, ADR 0017).
 *
 * A coin's metal (melt) value is composition × weight × spot. This module owns
 * the two pure steps: parsing Numista's free-text composition into a precious
 * metal + millesimal fineness, and turning that plus a weight and a EUR/oz spot
 * into a minor-unit value. The spot fetch (Stooq) and USD→EUR conversion (ECB)
 * live in the sync layer; here everything is injected so it stays pure.
 *
 * Composition text arrives in Spanish (the client requests lang=es), e.g.
 * "Plata 999", "Oro (.900)", "Cuproníquel".
 */

/** The four precious metals worthline values; base-metal alloys resolve to null. */
export type MetalKind = "gold" | "silver" | "platinum" | "palladium";

/** A parsed composition: the precious metal and its millesimal fineness (0–1000). */
export interface ParsedComposition {
  metal: MetalKind | null;
  finenessMillis: number | null;
}

/** The Stooq symbol carrying each metal's spot (per troy ounce, in USD). */
export const STOOQ_METAL_SYMBOL: Record<MetalKind, string> = {
  gold: "XAUUSD",
  silver: "XAGUSD",
  platinum: "XPTUSD",
  palladium: "XPDUSD",
};

const GRAMS_PER_TROY_OUNCE = 31.1034768;

// Order matters only for readability — the patterns are mutually exclusive
// (e.g. "platino" does not contain "plata").
const METAL_PATTERNS: ReadonlyArray<readonly [MetalKind, RegExp]> = [
  ["palladium", /paladio|palladium/i],
  ["platinum", /platino|platinum/i],
  ["gold", /\boro\b|gold/i],
  ["silver", /plata|silver/i],
];

/** Extract the first millesimal fineness from a composition string. A value ≤ 1
 *  is read as a fraction (".925" → 925); 1–1000 as millesimal directly. */
function parseFineness(text: string): number | null {
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  let value = Number.parseFloat(match[0]);
  if (value <= 1) {
    value *= 1000;
  }
  if (value > 1000) {
    return null;
  }
  return Math.round(value);
}

/**
 * Parse a Numista composition text into a precious metal + fineness. A base-metal
 * or unrecognised alloy yields `{ metal: null, finenessMillis: null }`; a named
 * metal with no number yields a known metal but unknown fineness.
 */
export function parseComposition(text: string | null): ParsedComposition {
  if (!text) {
    return { metal: null, finenessMillis: null };
  }
  const found = METAL_PATTERNS.find(([, pattern]) => pattern.test(text));
  if (!found) {
    return { metal: null, finenessMillis: null };
  }
  return { metal: found[0], finenessMillis: parseFineness(text) };
}

/** Everything the melt-value calculation consumes for one position. */
export interface MetalValueInput {
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  quantity: number;
  /** Spot price of the pure metal in EUR per troy ounce. */
  spotPerOzEur: number | null;
}

/**
 * The melt value of a position in minor units, or null when it cannot be
 * resolved — no precious metal, no weight, unknown fineness, or no spot. Returning
 * null (rather than 0) keeps it out of the `max(metal, numismatic)` comparison so
 * the coin leans on its numismatic estimate or purchase-price fallback (ADR 0017).
 */
export function metalValueMinor(input: MetalValueInput): number | null {
  const { metal, finenessMillis, weightGrams, quantity, spotPerOzEur } = input;
  if (
    metal === null ||
    finenessMillis === null ||
    weightGrams === null ||
    spotPerOzEur === null
  ) {
    return null;
  }
  const pureGrams = weightGrams * (finenessMillis / 1000);
  const ounces = pureGrams / GRAMS_PER_TROY_OUNCE;
  return Math.round(ounces * spotPerOzEur * quantity * 100);
}
