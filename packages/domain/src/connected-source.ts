/**
 * Connected source model + projection (PRD #160, ADR 0016/0017).
 *
 * A **connected source** is an external account worthline links to and mirrors
 * read-only (the first is Numista). Its **positions** are the lines it mirrors —
 * for Numista, the coins you hold. `projectConnectedSource` rolls the positions
 * up into the portfolio: one **holding** per source per **liquidity-ladder rung**
 * (Numista's coins are all illiquid → a single "Colección Numista" holding). The
 * holding's value is **derived** from its positions (never hand-set), so it is
 * excluded from the manual value update pass.
 *
 * This module is pure: it maps (source, positions) → holdings, with no network or
 * persistence. The Numista HTTP/auth lives behind the pricing package; the store
 * persists what this projection describes.
 */

import type { Instrument } from "./instrument-catalog";
import { LIQUIDITY_LADDER } from "./liquidity-ladder";
import type { LiquidityTier } from "./liquidity-ladder";
import type { CurrencyCode } from "./money";
import type { OwnershipShare } from "./workspace-types";

/** Which external account an adapter speaks to. Numista is the first. */
export type SourceAdapter = "numista";

/** A connected source: an external account worthline mirrors read-only (ADR 0016). */
export interface ConnectedSource {
  id: string;
  adapter: SourceAdapter;
  /** Display label for the projected holding(s), e.g. "Colección Numista". */
  label: string;
  /**
   * Ownership split for the projected holding(s). The source itself has no
   * ownership notion (ADR 0016); worthline owns it, defaulting to 100% the
   * connecting scope member — resolved at connect time, carried here.
   */
  ownership: OwnershipShare[];
}

/**
 * A single line a connected source mirrors — for Numista, a coin you own. Sits
 * beneath the projected holding as sub-detail, the way an operation sits beneath
 * an investment (ADR 0014). Carries grouping metadata (a coin's metal) for the
 * detail-page lens.
 */
export interface SourcePosition {
  id: string;
  sourceId: string;
  /**
   * The source's STABLE per-line id (Numista's collected-item id) — the identity
   * that survives a wholesale re-sync, distinct from worthline's internal `id`
   * (reassigned each sync) and from `catalogueId` (the type, shared by two coins
   * of the same kind). Diffing on it tells a genuinely new trade (ripple it into
   * history, ADR 0017) from a coin already frozen in past snapshots.
   */
  externalId: string;
  /** The source's catalogue id for this line (Numista type id). */
  catalogueId: string;
  /** The source's issue id within the catalogue type (Numista issue id); null
   *  when the source records none. Persisted so the valuation refresh can refetch
   *  the per-grade numismatic estimate without re-listing the collection (#166). */
  issueId: number | null;
  /** Denormalized display name for the catalogue detail list. */
  name: string;
  /** Condition rating assigned on Numista, read-only here (ADR 0017). */
  grade: string;
  quantity: number;
  /** The liquidity rung this position projects onto (Numista coins: "illiquid"). */
  liquidityTier: LiquidityTier;
  /** Grouping metadata for the holding's detail lens (a coin's metal); null when
   *  the source records no metal for the line. */
  metal: string | null;
  /** Indefinite coin detail (ADR 0017): the parsed millesimal fineness (0–1000)
   *  and weight in grams, stamped once at sync and never refetched. The valuation
   *  refresh recomputes the melt value from these × the daily metal spot (#166).
   *  Null when the catalogue records none / the composition has no precious metal. */
  finenessMillis: number | null;
  weightGrams: number | null;
  /** When the position entered the collection (its Numista acquisition date),
   *  YYYY-MM-DD; null when the user recorded none (an optional Numista field). */
  purchaseDate: string | null;
  /** Candidate value — the coin's melt value (composition × weight × spot), minor
   *  units; null when not resolved (e.g. a base-metal coin with no spot). */
  metalValueMinor: number | null;
  /** Candidate value — Numista's per-grade estimate, minor units; null when
   *  Numista has no estimate for this coin at its grade. */
  numismaticValueMinor: number | null;
  /** When the numismatic estimate was last fetched (ISO); null until first
   *  fetched. Drives the long-TTL refetch gate in the valuation refresh (#166). */
  numismaticFetchedAt: string | null;
  /** What was paid for the position, minor units; null when Numista records no
   *  trade price (an optional field — many users record none). */
  purchasePriceMinor: number | null;
  currency: CurrencyCode;
}

/** Which figure a coin's value came from — governs the detail-row label. */
export type ValuationBasis = "metal" | "numismatic" | "purchase" | "zero";

/** A coin's value with the basis that produced it. */
export interface CoinValuation {
  minor: number;
  basis: ValuationBasis;
}

/**
 * The value of one position (ADR 0017): the greater of its metal and numismatic
 * values; when neither is known (a base-metal coin Numista does not estimate), it
 * falls back to the purchase price; absent even that, it is 0 (the "value at 0"
 * case). A tie resolves to metal (the bullion floor). A *zero* candidate does not
 * count as "known" — only a positive metal/numismatic value wins over the
 * purchase-price fallback.
 */
export function coinValue(position: SourcePosition): CoinValuation {
  const metal = position.metalValueMinor ?? 0;
  const numismatic = position.numismaticValueMinor ?? 0;

  if (metal > 0 || numismatic > 0) {
    return metal >= numismatic
      ? { minor: metal, basis: "metal" }
      : { minor: numismatic, basis: "numismatic" };
  }
  if (position.purchasePriceMinor !== null) {
    return { minor: position.purchasePriceMinor, basis: "purchase" };
  }
  return { minor: 0, basis: "zero" };
}

/**
 * The coin collection's GLOBAL value on a past date, by **purchase-date accretion**
 * (ADR 0017, #167 fresh-generation companion): the sum of `coinValue` over the
 * positions acquired on or before `targetDate`. A position with no purchase date
 * has no dated fact and never enters history (parity with the sync ripple), so it
 * is excluded here too. Returns 0 when no dated coin was held yet — the caller
 * then omits the holding from that snapshot (it was not held). Values are the
 * coins' CURRENT values, frozen by the caller at generation time; worthline never
 * fetches a coin's historical price.
 */
export function coinCollectionValueAtDate(
  positions: readonly SourcePosition[],
  targetDate: string,
): number {
  return positions.reduce((sum, position) => {
    if (position.purchaseDate === null || position.purchaseDate > targetDate) {
      return sum;
    }
    return sum + coinValue(position).minor;
  }, 0);
}

/** A connected source's rolled-up holding on one liquidity rung (ADR 0016). */
export interface ProjectedHolding {
  /** Stable holding id, derived from the source and rung. */
  id: string;
  name: string;
  liquidityTier: LiquidityTier;
  /** Always `coin_collection` for Numista — derived, illiquid (ADR 0016). */
  instrument: Instrument;
  /** Derived value: the sum of its positions' coin values, minor units. */
  valueMinor: number;
  currency: CurrencyCode;
  ownership: OwnershipShare[];
  /** The positions on this rung — the holding's sub-detail. */
  positions: SourcePosition[];
}

/**
 * Project a connected source's positions into the portfolio: one rolled-up
 * holding per liquidity rung the positions occupy (ADR 0016). Numista's coins
 * are all illiquid, so it yields a single holding; a source whose positions
 * spanned rungs would split into one holding per rung.
 */
export function projectConnectedSource(
  source: ConnectedSource,
  positions: SourcePosition[],
): ProjectedHolding[] {
  const byRung = new Map<LiquidityTier, SourcePosition[]>();
  for (const position of positions) {
    const rung = byRung.get(position.liquidityTier) ?? [];
    rung.push(position);
    byRung.set(position.liquidityTier, rung);
  }

  // One holding per occupied rung, walked in ladder order for a stable result.
  return LIQUIDITY_LADDER.filter((rung) => byRung.has(rung)).map((rung) => {
    const rungPositions = byRung.get(rung)!;
    return {
      id: `${source.id}:${rung}`,
      name: source.label,
      liquidityTier: rung,
      instrument: "coin_collection",
      valueMinor: rungPositions.reduce(
        (sum, position) => sum + coinValue(position).minor,
        0,
      ),
      currency: rungPositions[0]!.currency,
      ownership: source.ownership,
      positions: rungPositions,
    };
  });
}

/** One metal's positions within a holding, with their summed coin value. */
export interface MetalGroup {
  /** The coin metal, or null for positions the source records no metal for. */
  metal: string | null;
  positions: SourcePosition[];
  subtotalMinor: number;
}

/**
 * Group a holding's positions by metal for the detail-page lens (the way the
 * collection is presented, CONTEXT). Most valuable group first; positions with
 * no metal collect under one group that always sinks to the bottom.
 */
export function groupPositionsByMetal(positions: SourcePosition[]): MetalGroup[] {
  const byMetal = new Map<string | null, SourcePosition[]>();
  for (const position of positions) {
    const group = byMetal.get(position.metal) ?? [];
    group.push(position);
    byMetal.set(position.metal, group);
  }

  const groups: MetalGroup[] = [...byMetal.entries()].map(([metal, group]) => ({
    metal,
    positions: group,
    subtotalMinor: group.reduce((sum, position) => sum + coinValue(position).minor, 0),
  }));

  return groups.sort((left, right) => {
    if (left.metal === null) return 1;
    if (right.metal === null) return -1;
    return (
      right.subtotalMinor - left.subtotalMinor || left.metal.localeCompare(right.metal)
    );
  });
}
