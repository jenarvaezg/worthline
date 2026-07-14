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

import type { DecimalString } from "./decimal";
import { multiplyToMinor } from "./decimal";
import type { Instrument } from "./instrument-catalog";
import type { LiquidityTier } from "./liquidity-ladder";
import { LIQUIDITY_LADDER } from "./liquidity-ladder";
import type { CurrencyCode } from "./money";
import { allocateScopedHolding } from "./scope-allocation";
import type { SnapshotPositionInput, SnapshotPositionRow } from "./snapshot-holdings";
import type { OwnershipShare } from "./workspace-types";

/** Which external account an adapter speaks to. Numista was the first; Binance is
 *  the first live-valued, rung-spanning source (ADR 0021). */
export type SourceAdapter = "numista" | "binance";

/**
 * The holding instrument a source projects into (ADR 0016/0021). Numista mirrors a
 * frozen, illiquid coin collection; Binance mirrors live-valued crypto. The single
 * adapter→instrument mapping the projection and `connect` both read so the
 * materialized holding and the projected one never disagree.
 */
export function instrumentForAdapter(adapter: SourceAdapter): Instrument {
  return adapter === "numista" ? "coin_collection" : "crypto";
}

/**
 * The hand-valued instrument a source's holding becomes when a disconnect FREEZES
 * it into a plain stored holding (PRD #160 story 21 / #245 S6, ADR 0016). The
 * live/derived source instrument ({@link instrumentForAdapter}) flips to a `stored`
 * one so the holding keeps its last value by hand, no longer tracking positions or
 * a live price: a Numista coin collection's physical nature is `precious_metal`;
 * crypto has no hand-valued kind of its own, so it lands on the neutral `other`
 * stored bucket. The effective valuation method is read off the instrument
 * (`defaultsFor(instrumentOfAsset(asset))`), so flipping the instrument is what
 * makes the holding hand-valued — setting the column alone would not.
 */
export function frozenInstrumentForAdapter(adapter: SourceAdapter): Instrument {
  return adapter === "numista" ? "precious_metal" : "other";
}

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
 * The fields every connected-source position carries, regardless of adapter (ADR
 * 0016/0021). A position sits beneath the projected holding as sub-detail, the way
 * an operation sits beneath an investment (ADR 0014).
 */
export interface PositionCore {
  id: string;
  sourceId: string;
  /**
   * The source's STABLE per-line id — the identity that survives a wholesale
   * re-sync, distinct from worthline's internal `id` (reassigned each sync). For
   * Numista it is the collected-item id (diffing on it tells a genuinely new trade
   * from a coin already frozen in past snapshots, ADR 0017); for Binance it keys a
   * token to its wallet (e.g. `BTC:spot`).
   */
  externalId: string;
  /** Denormalized display name for the detail list. */
  name: string;
  /** The liquidity rung this position projects onto. */
  liquidityTier: LiquidityTier;
  currency: CurrencyCode;
}

/**
 * A coin position — what a Numista source mirrors (ADR 0017). Carries grouping
 * metadata (the coin's metal) for the detail-page lens and the two frozen
 * candidate values (`max(metal, numismatic)`).
 */
export interface CoinPosition extends PositionCore {
  kind: "coin";
  /** The source's catalogue id for this line (Numista type id). */
  catalogueId: string;
  /** The source's issue id within the catalogue type (Numista issue id); null
   *  when the source records none. Persisted so the valuation refresh can refetch
   *  the per-grade numismatic estimate without re-listing the collection (#166). */
  issueId: number | null;
  /** Condition rating assigned on Numista, read-only here (ADR 0017). */
  grade: string;
  quantity: number;
  /** The coin's MINT year, read from the source's issue (#215); null when the
   *  catalogue records none. Distinct from `purchaseDate` (when it was acquired). */
  year: number | null;
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
  /** The obverse photo's thumbnail URL from Numista, stamped once at sync (ADR
   *  0017, like fineness/weight); null when the catalogue has no photo. Drives the
   *  coin gallery's image, falling back to a metal glyph when null (#272 x100). */
  obverseThumbUrl: string | null;
}

/**
 * A token balance — what a Binance source mirrors (ADR 0021). Unlike a coin's
 * frozen candidate values, a token stores its **balance** (a quantity, not a
 * value) and the last-fetched live unit price; the holding's value is derived
 * **live** as `balance × unitPrice`, refreshed on the stale-price pass.
 */
export interface TokenPosition extends PositionCore {
  kind: "token";
  /** The Binance asset symbol (e.g. `BTC`) — the grouping lens on the detail page,
   *  and the key the symbol→CoinGecko-id resolver maps to a priceable coin. */
  symbol: string;
  /** The token balance (a quantity, decimal string) — NOT a frozen value: the
   *  value is derived live as balance × unit price (ADR 0021). */
  balance: DecimalString;
  /** Which Binance wallet the balance came from (e.g. `spot`). A token held across
   *  several wallets is summed into one position (#247). */
  wallet: string;
  /** The last-fetched live EUR unit price (decimal string) from CoinGecko, or null
   *  when the symbol cannot be mapped/priced — then the position is valued 0 with
   *  the "value at 0" warning, still shown in detail (never silently dropped). */
  unitPrice: DecimalString | null;
  /** The token's logo URL, resolved from CoinGecko at sync and stamped on the
   *  position (#482, the live mirror of a coin's `obverseThumbUrl`); null when the
   *  symbol cannot be mapped/has no image → the listing falls back to a glyph. */
  imageUrl: string | null;
}

/**
 * A single line a connected source mirrors. Polymorphic by adapter (ADR 0021): a
 * frozen `coin` (Numista) or a live-valued token `balance` (Binance).
 */
export type SourcePosition = CoinPosition | TokenPosition;

/**
 * `Omit` that DISTRIBUTES over a union. Plain `Omit<A | B, K>` collapses to the
 * shared keys (TS computes `keyof (A | B)` as the intersection), silently dropping
 * each variant's discriminated fields — so an "input" / "exported" view of a
 * `SourcePosition` must omit per-member to keep the coin/token shapes intact.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

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
export function coinValue(
  position: Pick<
    CoinPosition,
    "metalValueMinor" | "numismaticValueMinor" | "purchasePriceMinor"
  >,
): CoinValuation {
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
  positions: readonly CoinPosition[],
  targetDate: string,
): number {
  return positions.reduce((sum, position) => {
    if (position.purchaseDate === null || position.purchaseDate > targetDate) {
      return sum;
    }
    return sum + coinValue(position).minor;
  }, 0);
}

/** Which figure a token's value came from — governs the detail-row label. A token
 *  is valued live (`market`); an unmapped/unpriceable one falls to `zero`. */
export type TokenValuationBasis = "market" | "zero";

/** A token position's value with the basis that produced it. */
export interface PositionValuation {
  minor: number;
  basis: TokenValuationBasis;
}

/**
 * The value of one token position (ADR 0021): its balance × the current EUR unit
 * price, in minor units. Unlike a coin's frozen `max(metal, numismatic)`, a token
 * is valued **live** — the price is the freshly-fetched CoinGecko quote, refreshed
 * on the stale-price pass. A token that cannot be mapped or priced carries a null
 * price and falls to value 0 with the `zero` basis — the "value at 0" case, still
 * shown in the holding's detail, never silently dropped.
 */
export function positionValue(
  balance: DecimalString,
  unitPrice: DecimalString | null,
): PositionValuation {
  if (unitPrice === null) {
    return { minor: 0, basis: "zero" };
  }
  return { minor: multiplyToMinor(balance, unitPrice), basis: "market" };
}

/**
 * The minor-unit threshold below which a token's euro value is "dust" — junk worth
 * less than a cent, including unpriceable tokens that resolve to 0 with the `zero`
 * basis. A value `< TOKEN_DUST_THRESHOLD_MINOR` rounds to 0,00 € at display
 * precision. Bump it to hide more (e.g. 10 ⇒ under 0,10 €).
 */
export const TOKEN_DUST_THRESHOLD_MINOR = 1;

/**
 * Whether a token's euro value (minor units) is dust and hidden from the human
 * token listings by default (#479). DISPLAY-ONLY: dust is never dropped from
 * snapshots, export/import, or reconciliation (ADR 0035) — only its rows and the
 * "Tokens" count are suppressed. See {@link TOKEN_DUST_THRESHOLD_MINOR}.
 */
export function isTokenDustValue(valueMinor: number): boolean {
  return valueMinor < TOKEN_DUST_THRESHOLD_MINOR;
}

/**
 * The value of one position, dispatched by kind (ADR 0021): a coin's frozen
 * `max(metal, numismatic)` vs a token's live `balance × unit price`. The single
 * per-position rule the projection sums and the detail page reads.
 */
export function projectedPositionValue(position: SourcePosition): number {
  return position.kind === "coin"
    ? coinValue(position).minor
    : positionValue(position.balance, position.unitPrice).minor;
}

/**
 * Freeze a coin into the per-position snapshot input it contributes to its
 * holding's breakdown (ADR 0035). Carries the coin's STABLE key (its Numista
 * `externalId`, ADR 0017 — never the reassigned internal id), its name, its frozen
 * `coinValue` (`max(metal, numismatic)`, purchase-price fallback), and the display
 * metadata the second drilldown level renders (metal + obverse thumbnail). Value
 * and labels only — no secrets. The capture scope-allocates these values down to
 * the holding's owned share.
 */
export function coinPositionSnapshotInput(coin: CoinPosition): SnapshotPositionInput {
  return {
    positionKey: coin.externalId,
    label: coin.name,
    valueMinor: coinValue(coin).minor,
    metal: coin.metal,
    imageUrl: coin.obverseThumbUrl,
  };
}

/**
 * Merge live Numista coin inputs with a same-day frozen breakdown (ADR 0035).
 * New coins pass through with their live value; removed coins drop out; coins
 * whose scoped value is unchanged keep their frozen GLOBAL value so a same-day
 * recapture (latest wins, ADR 0005) does not rewrite every line when only some
 * metal spots moved. Binance stays live-valued every capture — this is Numista-
 * only semantics (ADR 0017 acquisition-driven freeze).
 */
export function mergeCoinPositionSnapshotInputs(
  live: readonly SnapshotPositionInput[],
  frozenScoped: readonly SnapshotPositionRow[],
  scope: { ownership: OwnershipShare[]; scopeMemberIds: Set<string> },
): SnapshotPositionInput[] {
  const frozenByKey = new Map(frozenScoped.map((row) => [row.positionKey, row]));
  return live.map((coin) => {
    const frozen = frozenByKey.get(coin.positionKey);
    if (!frozen) {
      return coin;
    }
    const liveScoped = allocateScopedHolding(coin.valueMinor, scope).ownedMinor;
    if (
      liveScoped === frozen.valueMinor &&
      frozen.label === coin.label &&
      frozen.metal === coin.metal &&
      frozen.imageUrl === coin.imageUrl
    ) {
      const { totalShareBps } = allocateScopedHolding(coin.valueMinor, scope);
      if (totalShareBps === 0) {
        return coin;
      }
      const frozenGlobal = Math.round((frozen.valueMinor * 10_000) / totalShareBps);
      return { ...coin, valueMinor: frozenGlobal };
    }
    return coin;
  });
}

/**
 * Freeze a Binance holding's tokens into per-position snapshot inputs keyed by
 * SYMBOL, not `symbol:wallet` (ADR 0035, PRD #459 S2) — the live-valued mirror of
 * {@link coinPositionSnapshotInput}, folded through the same {@link
 * groupPositionsByToken} lens the live detail page uses (#247). A token spread
 * across wallets (spot · funding · flexible-earn) collapses into ONE position so
 * the histórico drilldown keys it on the identity a human cares about: BTC stays
 * BTC whether it sits in Spot or Earn. Keying on `symbol:wallet` instead made a
 * balance shifting wallets read as the whole position LEAVING under the old key
 * and a NEW one arriving under the new key — a phantom sell+buy whose net was
 * only the day's price drift (the SALIÓ/NUEVO artifact).
 *
 * `positionKey` and `label` are the symbol; `valueMinor` is the group's summed
 * live value (`Σ balance × unit price`; 0 for an all-unpriceable group, still
 * frozen so the row is never silently dropped). A token has no metal → null; the
 * logo is the group's first non-null `imageUrl` (one symbol resolves to one
 * logo) so the drilldown can render it for past days too (#482), glyph-falling-
 * back when null. Value and labels only — no secrets. The capture scope-allocates
 * these values down to the holding's owned share.
 */
export function tokenSymbolSnapshotInputs(
  tokens: TokenPosition[],
): SnapshotPositionInput[] {
  return groupPositionsByToken(tokens).map((group) => ({
    positionKey: group.symbol,
    label: group.symbol,
    valueMinor: group.subtotalMinor,
    metal: null,
    imageUrl: group.positions.find((p) => p.imageUrl !== null)?.imageUrl ?? null,
  }));
}

/**
 * Carry each token's last-good live unit price forward onto a fresh sync's positions.
 * A connected-source sync replaces a source's positions wholesale and
 * re-derives each holding's value live (`balance × unitPrice`, ADR 0021). A token
 * whose price could NOT be fetched this round arrives with `unitPrice: null`, which
 * {@link positionValue} scores 0 — silently zeroing a real, previously-valued holding
 * on a single transient CoinGecko miss (a 429 / empty body, the more likely for a
 * low-cap token fetched late in the price burst). That is the WBETH-vanished bug: a
 * Binance balance the account still holds dropping to 0 € until a later sync happens
 * to price it cleanly.
 *
 * The fix: for each incoming token whose `unitPrice` is null, if the SAME position
 * (matched by its stable `externalId` = `symbol:wallet`) carried a non-null price on
 * the prior sync, carry that last-good price forward. The value then stays intact
 * (at most one refresh stale) and self-heals the next time the token prices cleanly;
 * it is never zeroed by a transient miss. A token genuinely new this sync (no prior
 * position) or one never priced has nothing to carry and is left null (unchanged) —
 * we never fabricate a price. Coins are untouched (they freeze their own value, ADR
 * 0017). Pure: returns a NEW array, mutating neither input.
 *
 * Deliberately NOT bounded by a staleness window: a genuinely delisted token would
 * keep its last price rather than dropping to 0. That is the safe default for a net
 * worth tool (a stale value beats a phantom loss), and the next clean price corrects
 * it; bounding it is a future refinement, not this fix.
 */
export function carryForwardTokenUnitPrices(
  incoming: readonly DistributiveOmit<SourcePosition, "id" | "sourceId">[],
  previous: readonly SourcePosition[],
): DistributiveOmit<SourcePosition, "id" | "sourceId">[] {
  const lastGoodByExternalId = new Map<string, DecimalString>();
  for (const position of previous) {
    if (position.kind === "token" && position.unitPrice !== null) {
      lastGoodByExternalId.set(position.externalId, position.unitPrice);
    }
  }

  if (lastGoodByExternalId.size === 0) return [...incoming];

  return incoming.map((position) => {
    if (position.kind !== "token" || position.unitPrice !== null) return position;
    const carried = lastGoodByExternalId.get(position.externalId);
    return carried === undefined ? position : { ...position, unitPrice: carried };
  });
}

/** A connected source's rolled-up holding on one liquidity rung (ADR 0016). */
export interface ProjectedHolding {
  /** Stable holding id, derived from the source and rung. */
  id: string;
  name: string;
  liquidityTier: LiquidityTier;
  /** The instrument this source projects into — `coin_collection` for Numista,
   *  `crypto` for Binance (ADR 0016/0021). Always derived. */
  instrument: Instrument;
  /** Derived value: the sum of its positions' values, minor units. */
  valueMinor: number;
  currency: CurrencyCode;
  ownership: OwnershipShare[];
  /** The positions on this rung — the holding's sub-detail. */
  positions: SourcePosition[];
}

/**
 * Project a connected source's positions into the portfolio: one rolled-up
 * holding per liquidity rung the positions occupy (ADR 0016). Numista's coins
 * are all illiquid, so it yields a single holding; Binance spans rungs (market +
 * term-locked), so it splits into one holding per rung. The holding instrument is
 * the adapter's (`coin_collection` / `crypto`); the value sums each position's
 * value by kind (frozen coin vs live token).
 */
export function projectConnectedSource(
  source: ConnectedSource,
  positions: SourcePosition[],
): ProjectedHolding[] {
  const instrument = instrumentForAdapter(source.adapter);
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
      instrument,
      valueMinor: rungPositions.reduce(
        (sum, position) => sum + projectedPositionValue(position),
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
  positions: CoinPosition[];
  subtotalMinor: number;
}

/**
 * Group a holding's positions by metal for the detail-page lens (the way the
 * collection is presented, CONTEXT). Most valuable group first; positions with
 * no metal collect under one group that always sinks to the bottom.
 */
export function groupPositionsByMetal(positions: CoinPosition[]): MetalGroup[] {
  const byMetal = new Map<string | null, CoinPosition[]>();
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

/** One token's positions within a Binance holding, with their summed live value
 *  (#247). A token held across wallets (spot · funding · flexible-Earn) collects
 *  here under one symbol; each position keeps its `wallet`, so the wallet origin is
 *  available as per-position metadata. */
export interface TokenGroup {
  symbol: string;
  positions: TokenPosition[];
  subtotalMinor: number;
}

/**
 * Group a Binance holding's positions by token symbol for the detail-page lens
 * (the mirror of `groupPositionsByMetal`, #247). A token spanning several wallets
 * folds into ONE group whose `subtotalMinor` sums each position's live value
 * (`balance × unitPrice`); an unpriceable position contributes 0 but still groups.
 * Most valuable token first, ties broken by symbol ascending for a stable order.
 * Unlike `groupPositionsByMetal`, a token's `symbol` is always present, so there is
 * no null group to sink to the bottom.
 */
export function groupPositionsByToken(positions: TokenPosition[]): TokenGroup[] {
  const bySymbol = new Map<string, TokenPosition[]>();
  for (const position of positions) {
    const group = bySymbol.get(position.symbol) ?? [];
    group.push(position);
    bySymbol.set(position.symbol, group);
  }

  const groups: TokenGroup[] = [...bySymbol.entries()].map(([symbol, group]) => ({
    symbol,
    positions: group,
    subtotalMinor: group.reduce(
      (sum, position) => sum + positionValue(position.balance, position.unitPrice).minor,
      0,
    ),
  }));

  return groups.sort(
    (left, right) =>
      right.subtotalMinor - left.subtotalMinor || left.symbol.localeCompare(right.symbol),
  );
}
