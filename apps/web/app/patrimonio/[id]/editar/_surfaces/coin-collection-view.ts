/**
 * Pure view helpers for the Numista coin-collection catalogue (PRD #160 / #163,
 * variant B «Reparto por metal»). They turn the domain's metal groups into the
 * composition strip + descending equalizer the detail page renders — the maths
 * (floored, re-normalized segment widths; percent labels; metal identity) lives
 * here so it is unit-testable without React or a database.
 *
 * No network, no persistence, no Next.js: maps (groups, total) → view rows.
 */

import type { CoinValuation, MetalGroup, ValuationBasis } from "@worthline/domain";

/** A floor so a near-invisible metal (e.g. 0,2 %) still shows a sliver of bar. */
export const MIN_SHARE_PCT = 2;

/** The display identity of a metal: an es-ES label + a decorative tone.
 *
 * The tones are intentionally NOT design-system semantic tokens — `--gold` is
 * reserved for warnings, `--green`/`--red` for movement (design-system §4). They
 * are a restrained, collection-only decorative palette (ADR/NOTES #162 decision),
 * keyed by Numista's English metal slug (the `metal` field on a position). An
 * unknown or absent metal falls back to a neutral line tone. */
export interface MetalIdentity {
  label: string;
  tone: string;
}

const METAL_IDENTITY: Record<string, MetalIdentity> = {
  gold: { label: "Oro", tone: "var(--coin-gold)" },
  silver: { label: "Plata", tone: "var(--coin-silver)" },
  platinum: { label: "Platino", tone: "var(--coin-platinum)" },
  palladium: { label: "Paladio", tone: "var(--coin-palladium)" },
  copper: { label: "Cobre", tone: "var(--coin-copper)" },
  bronze: { label: "Bronce", tone: "var(--coin-bronze)" },
  brass: { label: "Latón", tone: "var(--coin-brass)" },
  nickel: { label: "Níquel", tone: "var(--coin-nickel)" },
  "copper-nickel": { label: "Cuproníquel", tone: "var(--coin-cupronickel)" },
  cupronickel: { label: "Cuproníquel", tone: "var(--coin-cupronickel)" },
  steel: { label: "Acero", tone: "var(--coin-steel)" },
  zinc: { label: "Zinc", tone: "var(--coin-zinc)" },
  aluminium: { label: "Aluminio", tone: "var(--coin-aluminium)" },
};

const UNKNOWN_METAL: MetalIdentity = { label: "Sin metal", tone: "var(--line)" };

/** Resolve a position's metal slug to its display label + decorative tone. */
export function metalIdentity(metal: string | null): MetalIdentity {
  if (metal === null) {
    return UNKNOWN_METAL;
  }
  return METAL_IDENTITY[metal.toLowerCase()] ?? { label: metal, tone: "var(--line)" };
}

/** The es-ES label + CSS class for a coin's valuation basis (the row's tag). */
export interface BasisTag {
  label: string;
  cls: string;
}

export function basisTag(basis: ValuationBasis): BasisTag {
  switch (basis) {
    case "metal":
      return { label: "Metal", cls: "coinTagMetal" };
    case "numismatic":
      return { label: "Colección", cls: "coinTagNumismatic" };
    case "purchase":
      return { label: "Compra", cls: "coinTagPurchase" };
    case "zero":
      return { label: "Sin valor", cls: "coinTagZero" };
  }
}

/** Format a percentage the way the strip/equalizer label it ("<1 %", "82 %"). */
export function formatSharePct(pct: number): string {
  if (pct <= 0) {
    return "0 %";
  }
  return pct < 1 ? "<1 %" : `${Math.round(pct)} %`;
}

/** A view row for one metal: its identity, subtotal, true %, and bar width %. */
export interface MetalRow {
  metal: string | null;
  identity: MetalIdentity;
  subtotalMinor: number;
  positions: MetalGroup["positions"];
  /** The metal's true share of the collection total (0 when total is 0). */
  pct: number;
  /** The clamped bar width for the equalizer (≥ MIN_SHARE_PCT when present). */
  barWidth: number;
}

/** A segment of the 100 %-stacked strip: a re-normalized, floored width. */
export interface StripSegment {
  metal: string | null;
  identity: MetalIdentity;
  /** True share (for the tooltip/label). */
  pct: number;
  /** Re-normalized width so the floored segments still sum to 100 %. */
  width: number;
}

/** The full view model the catalogue renders: ordered rows + strip segments. */
export interface CoinCollectionView {
  totalMinor: number;
  coinCount: number;
  rows: MetalRow[];
  segments: StripSegment[];
}

/** Count the coins across a metal group's positions (sum of quantities). */
export function metalCoinCount(positions: MetalGroup["positions"]): number {
  return positions.reduce((sum, position) => sum + position.quantity, 0);
}

/**
 * Build the catalogue view model from the domain's metal groups (already sorted
 * most-valuable-first, no-metal last). Percentages are the true share of the
 * total; the strip widths apply a visibility floor and re-normalize so the
 * floored segments still add up to 100 % (the prototype's accepted inexactitude).
 */
export function buildCoinCollectionView(
  groups: MetalGroup[],
  totalMinor: number,
): CoinCollectionView {
  const rows: MetalRow[] = groups.map((group) => {
    const pct = totalMinor > 0 ? (group.subtotalMinor / totalMinor) * 100 : 0;
    return {
      metal: group.metal,
      identity: metalIdentity(group.metal),
      subtotalMinor: group.subtotalMinor,
      positions: group.positions,
      pct,
      barWidth: Math.max(pct, MIN_SHARE_PCT),
    };
  });

  const flooredSum = rows.reduce((sum, row) => sum + Math.max(row.pct, MIN_SHARE_PCT), 0);
  const segments: StripSegment[] = rows.map((row) => ({
    metal: row.metal,
    identity: row.identity,
    pct: row.pct,
    width: flooredSum > 0 ? (Math.max(row.pct, MIN_SHARE_PCT) / flooredSum) * 100 : 0,
  }));

  const coinCount = rows.reduce((sum, row) => sum + metalCoinCount(row.positions), 0);

  return { totalMinor, coinCount, rows, segments };
}

/** Re-export so the view can label a coin's basis without a second import path. */
export type { CoinValuation };
