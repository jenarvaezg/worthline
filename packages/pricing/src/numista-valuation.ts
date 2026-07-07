/**
 * Numista valuation — the single home for "value a Numista coin" (ADR 0017, #323).
 *
 * Numista lists coins (the on-demand sync) and re-derives what stored coins are
 * worth (the decoupled stale-price pass). Both resolve the
 * SAME two candidate values per coin — the melt value (composition × weight ×
 * metal spot) and Numista's per-grade numismatic estimate — and leave the
 * `max(metal, numismatic)` decision to the domain (`coinValuation`). Parsing,
 * request-cap dedup, the numismatic TTL gate, and the candidate-row construction
 * live in ONE place shared by both modes.
 *
 * Every external read is injected, so this is a pure unit of work testable without
 * the network: the web layer wires the real readers (with the API key + token) and
 * a Stooq/ECB spot resolver. Type details, per-metal spot, and per-issue estimates
 * are deduped to stay within Numista's request cap (ADR 0017).
 */

import type { CoinPosition } from "@worthline/domain";

import {
  COIN_VALUE_TTL_DAYS,
  coinValuation,
  isNumismaticStale,
} from "@pricing/coin-valuation";
import type { PriceProvider } from "@pricing/index";
import type { MetalKind } from "@pricing/metal";
import { parseComposition, STOOQ_METAL_SYMBOL } from "@pricing/metal";
import { mapCollectedItem } from "@pricing/numista";
import type {
  NumistaCollectedItem,
  NumistaPrices,
  NumistaTypeDetail,
} from "@pricing/numista";
import { resolveProvider } from "@pricing/registry";

/** A coin position ready to persist — the store assigns its id + sourceId. */
export type PositionDraft = Omit<CoinPosition, "id" | "sourceId">;

/** The long TTL for refetching a coin's numismatic estimate (ADR 0017). Sourced
 *  from the single coin-value staleness config so it never drifts behind a second
 *  independent literal (#240). */
export const NUMISMATIC_TTL_DAYS = COIN_VALUE_TTL_DAYS.numismaticEstimate;

// ── Shared injected reads ─────────────────────────────────────────────────────

/** The external reads the full sync needs, injected for testability. */
export interface NumistaSyncDeps {
  /** List the user's coins (the OAuth-gated collection read). */
  listItems: () => Promise<NumistaCollectedItem[]>;
  /** Catalogue detail for a type (composition + weight). */
  typeDetail: (typeId: number) => Promise<NumistaTypeDetail>;
  /** Per-grade estimates for an issue, or null when unavailable. */
  prices: (typeId: number, issueId: number) => Promise<NumistaPrices | null>;
  /** Metal spot in EUR per troy ounce, or null when unavailable. */
  spotPerOzEur: (metal: MetalKind) => Promise<number | null>;
}

/** The external reads the decoupled refresh needs, injected for testability. */
export interface RevalueDeps {
  /** Per-grade estimates for an issue, or null when unavailable (Numista-capped). */
  prices: (typeId: number, issueId: number) => Promise<NumistaPrices | null>;
  /** Metal spot in EUR per troy ounce, or null on outage (free: Stooq + ECB). */
  spotPerOzEur: (metal: MetalKind) => Promise<number | null>;
}

export interface RevalueOptions {
  nowIso: string;
  /** Override the numismatic refetch TTL (defaults to {@link NUMISMATIC_TTL_DAYS}). */
  numismaticTtlDays?: number;
}

/**
 * A stored coin position carrying the persisted detail needed to revalue it
 * without re-listing the collection: its catalogue/issue ids, grade, the
 * indefinite composition detail (metal/fineness/weight), the last-known candidate
 * values, and when the numismatic estimate was last fetched.
 */
export interface RevaluePosition {
  id: string;
  typeId: number;
  issueId: number | null;
  grade: string;
  quantity: number;
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  /** Last-known candidate values — kept when a refresh input is unavailable. */
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
  /** When the numismatic estimate was last fetched; null until first fetched. */
  numismaticFetchedAt: string | null;
}

/** A position's candidate values after a refresh pass. */
export interface RevaluedPosition {
  id: string;
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
  numismaticFetchedAt: string | null;
}

// ── Shared request-cap dedup + numismatic TTL gate ────────────────────────────

/**
 * Per-metal spot + per-issue estimate dedup, shared by sync AND revalue (ADR 0017
 * request-cap discipline). A collection of N coins makes at most one spot lookup
 * per metal and one estimate lookup per (type, issue); estimates memoize the
 * in-flight promise so two positions sharing an issue await the same single fetch.
 */
function createValuationCache(deps: {
  prices: (typeId: number, issueId: number) => Promise<NumistaPrices | null>;
  spotPerOzEur: (metal: MetalKind) => Promise<number | null>;
}) {
  const spotByMetal = new Map<MetalKind, number | null>();
  const pricesByIssue = new Map<string, Promise<NumistaPrices | null>>();

  const resolveSpot = async (metal: MetalKind | null): Promise<number | null> => {
    if (metal === null) {
      return null;
    }
    if (!spotByMetal.has(metal)) {
      spotByMetal.set(metal, await deps.spotPerOzEur(metal));
    }
    return spotByMetal.get(metal) ?? null;
  };

  const resolvePrices = (
    typeId: number,
    issueId: number,
  ): Promise<NumistaPrices | null> => {
    const key = `${typeId}:${issueId}`;
    let pending = pricesByIssue.get(key);
    if (!pending) {
      pending = deps.prices(typeId, issueId);
      pricesByIssue.set(key, pending);
    }
    return pending;
  };

  return { resolveSpot, resolvePrices };
}

/** Whether a position's numismatic estimate is past its refetch TTL. Defers to
 *  the coin-value module's clock by default (#240); honours the test/override TTL
 *  when one is supplied. */
function numismaticPastTtl(
  fetchedAt: string | null,
  nowIso: string,
  overrideTtlDays: number | undefined,
): boolean {
  if (overrideTtlDays === undefined) {
    return isNumismaticStale(fetchedAt, nowIso);
  }
  if (fetchedAt === null) {
    return true;
  }
  const ageMs = new Date(nowIso).getTime() - new Date(fetchedAt).getTime();
  return ageMs >= overrideTtlDays * 86400000;
}

/** The composition detail a coin valuation needs (shared by sync + revalue). */
interface CoinDetail {
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  quantity: number;
  grade: string;
}

/** The fresh inputs a valuation pass resolves (shared by sync + revalue). */
interface CoinValuationInputs {
  spotPerOzEur: number | null;
  prices: NumistaPrices | null;
  numismaticFetchedAt: string | null;
  purchasePriceMinor: number | null;
  lastMetalValueMinor: number | null;
  lastNumismaticValueMinor: number | null;
  nowIso: string;
}

/** The candidate minors a coin resolves to — the SINGLE row-construction point the
 *  sync and the revalue both call, so `max(metal, numismatic)` is decided once. */
function candidateValues(
  detail: CoinDetail,
  inputs: CoinValuationInputs,
): {
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
} {
  const valuation = coinValuation({
    metal: detail.metal,
    finenessMillis: detail.finenessMillis,
    weightGrams: detail.weightGrams,
    quantity: detail.quantity,
    grade: detail.grade,
    spotPerOzEur: inputs.spotPerOzEur,
    prices: inputs.prices?.prices ?? null,
    numismaticFetchedAt: inputs.numismaticFetchedAt,
    purchasePriceMinor: inputs.purchasePriceMinor,
    lastMetalValueMinor: inputs.lastMetalValueMinor,
    lastNumismaticValueMinor: inputs.lastNumismaticValueMinor,
    nowIso: inputs.nowIso,
  });
  return {
    metalValueMinor: valuation.metal.minor,
    numismaticValueMinor: valuation.numismatic.minor,
  };
}

// ── The full sync (listPositions) ─────────────────────────────────────────────

/**
 * A persisted coin whose detail a re-sync reuses instead of re-calling Numista
 * (ADR 0017 request-cap). Mirror of the stored coin shape; the web layer maps its
 * `CoinPosition`s to this. Two reuse seams:
 *  • `getType` — the type detail (composition/weight/thumbnail) is STATIC, so a
 *    type already in the collection is never refetched.
 *  • `getPrices` — a still-fresh numismatic estimate (same issue/grade/quantity,
 *    within the long TTL) is carried forward; the decoupled revalue refetches once
 *    it lapses.
 */
export interface SyncedCoin {
  externalId: string;
  /** Numista type id as stored (string); parsed back to a number to key reuse. */
  catalogueId: string;
  issueId: number | null;
  grade: string;
  quantity: number;
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  obverseThumbUrl: string | null;
  numismaticValueMinor: number | null;
  numismaticFetchedAt: string | null;
}

/** The static, type-level detail a coin valuation needs — the part of a `getType`
 *  response we persist and never need to refetch (composition is fixed). */
interface CoinTypeDetail {
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  obverseThumbUrl: string | null;
}

export async function syncNumistaCollection(
  deps: NumistaSyncDeps,
  nowIso: string,
  existing: readonly SyncedCoin[] = [],
  options: { numismaticTtlDays?: number } = {},
): Promise<PositionDraft[]> {
  const items = await deps.listItems();

  // Seed the reuse caches from what's already persisted so a re-sync of an
  // unchanged collection makes ZERO getType/getPrices calls (ADR 0017): only
  // genuinely new or changed coins hit the network.
  const detailByType = new Map<number, CoinTypeDetail>();
  for (const coin of existing) {
    const typeId = Number(coin.catalogueId);
    if (Number.isInteger(typeId) && !detailByType.has(typeId)) {
      detailByType.set(typeId, {
        metal: coin.metal,
        finenessMillis: coin.finenessMillis,
        weightGrams: coin.weightGrams,
        obverseThumbUrl: coin.obverseThumbUrl,
      });
    }
  }
  const priorByExternal = new Map(existing.map((coin) => [coin.externalId, coin]));

  const cache = createValuationCache(deps);
  const drafts: PositionDraft[] = [];

  for (const item of items) {
    const base = mapCollectedItem(item);
    const typeId = item.type.id;

    // getType: static type detail — fetch once per unseen type, reuse thereafter.
    let detail = detailByType.get(typeId);
    if (!detail) {
      const fetched = await deps.typeDetail(typeId);
      const composition = parseComposition(fetched.compositionText);
      detail = {
        metal: composition.metal,
        finenessMillis: composition.finenessMillis,
        weightGrams: fetched.weightGrams,
        obverseThumbUrl: fetched.obverseThumbUrl,
      };
      detailByType.set(typeId, detail);
    }

    const spot = await cache.resolveSpot(detail.metal);

    // getPrices: reuse the persisted numismatic estimate when the line is unchanged
    // and still within its TTL; otherwise (new/changed coin, or lapsed) fetch once.
    // Passing `prices: null` + the prior stamp/value makes the coin-value module
    // keep the persisted figure verbatim — byte-identical to the revalue path.
    const prior = priorByExternal.get(String(item.id));
    const reusable =
      prior &&
      prior.issueId === base.issueId &&
      prior.grade === base.grade &&
      prior.quantity === base.quantity &&
      prior.numismaticFetchedAt !== null &&
      !numismaticPastTtl(prior.numismaticFetchedAt, nowIso, options.numismaticTtlDays)
        ? prior
        : null;

    let prices: NumistaPrices | null = null;
    let numismaticFetchedAt: string | null = null;
    let lastNumismaticValueMinor: number | null = null;
    if (reusable) {
      numismaticFetchedAt = reusable.numismaticFetchedAt;
      lastNumismaticValueMinor = reusable.numismaticValueMinor;
    } else if (base.issueId !== null && base.grade) {
      prices = await cache.resolvePrices(typeId, base.issueId);
      numismaticFetchedAt = nowIso;
    }

    // The shared candidate-row construction: the coin-value module owns both
    // candidate computations + the decision; the sync only supplies the
    // freshly-fetched (or reused) spot/prices.
    const candidates = candidateValues(
      {
        metal: detail.metal,
        finenessMillis: detail.finenessMillis,
        weightGrams: detail.weightGrams,
        quantity: item.quantity,
        grade: base.grade,
      },
      {
        spotPerOzEur: spot,
        prices,
        numismaticFetchedAt,
        purchasePriceMinor: base.purchasePriceMinor,
        lastMetalValueMinor: null,
        lastNumismaticValueMinor,
        nowIso,
      },
    );

    drafts.push({
      kind: "coin",
      externalId: String(item.id),
      catalogueId: base.catalogueId,
      issueId: base.issueId,
      name: base.name,
      grade: base.grade,
      quantity: base.quantity,
      year: base.year,
      liquidityTier: "illiquid",
      metal: detail.metal,
      finenessMillis: detail.finenessMillis,
      weightGrams: detail.weightGrams,
      purchaseDate: base.purchaseDate,
      metalValueMinor: candidates.metalValueMinor,
      numismaticValueMinor: candidates.numismaticValueMinor,
      numismaticFetchedAt,
      purchasePriceMinor: base.purchasePriceMinor,
      obverseThumbUrl: detail.obverseThumbUrl,
      currency: base.currency,
    });
  }

  return drafts;
}

// ── The decoupled revalue ─────────────────────────────────────────────────────

export async function refreshCoinValuations(
  positions: RevaluePosition[],
  deps: RevalueDeps,
  options: RevalueOptions,
): Promise<RevaluedPosition[]> {
  // Same per-metal + per-issue dedup the sync uses (ADR 0017 request-cap discipline).
  const cache = createValuationCache(deps);

  const results: RevaluedPosition[] = [];
  for (const position of positions) {
    // ── Spot is fetched here (the I/O); the candidate math + decision live in the
    //    coin-value module. An outage keeps the last-known metal figure (#240).
    const spot = await cache.resolveSpot(position.metal);

    // ── Numismatic: refetch only once the long TTL has lapsed (or never fetched);
    //    the staleness clock is the module's. A successful fetch advances the
    //    fetched-at stamp and supplies fresh prices to the module; otherwise we
    //    keep the prior stamp and pass null prices so it keeps the last-known.
    let prices: NumistaPrices | null = null;
    let numismaticFetchedAt = position.numismaticFetchedAt;

    if (
      numismaticPastTtl(
        position.numismaticFetchedAt,
        options.nowIso,
        options.numismaticTtlDays,
      ) &&
      position.issueId !== null &&
      position.grade
    ) {
      const priced = await cache.resolvePrices(position.typeId, position.issueId);
      if (priced !== null) {
        prices = priced;
        numismaticFetchedAt = options.nowIso;
      }
      // priced === null → leave value + fetched-at untouched so it retries next pass.
    }

    const candidates = candidateValues(
      {
        metal: position.metal,
        finenessMillis: position.finenessMillis,
        weightGrams: position.weightGrams,
        quantity: position.quantity,
        grade: position.grade,
      },
      {
        spotPerOzEur: spot,
        prices,
        numismaticFetchedAt,
        // The fallback rungs do not apply to the candidate refresh; the rollup owns
        // the purchase/zero choice when both candidates are unresolved.
        purchasePriceMinor: null,
        lastMetalValueMinor: position.metalValueMinor,
        lastNumismaticValueMinor: position.numismaticValueMinor,
        nowIso: options.nowIso,
      },
    );

    results.push({
      id: position.id,
      metalValueMinor: candidates.metalValueMinor,
      numismaticValueMinor: candidates.numismaticValueMinor,
      numismaticFetchedAt,
    });
  }

  return results;
}

// ── The metal spot resolver (Stooq × ECB) ─────────────────────────────────────

/** A provider result that carries a usable numeric price. */
function priceOf(
  result: Awaited<ReturnType<PriceProvider["fetchPrice"]>>,
): number | null {
  if (!result || "failed" in result) {
    return null;
  }
  const value = Number(result.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The EUR-per-troy-ounce spot for a metal: Stooq's USD spot (e.g. XAGUSD) times
 * the ECB EUR/USD rate (ADR 0017 — no new credentialed dependency). Returns null
 * on any failure so a transient outage leaves the metal value unresolved (the
 * coin then leans on its numismatic estimate) rather than throwing.
 */
export async function fetchMetalSpotEur(
  metal: MetalKind,
  nowIso: string,
): Promise<number | null> {
  try {
    // Resolve both legs through the registry (issue #243) so no cross-provider
    // import is buried here; the metal spot stays a composition pipeline (both
    // legs must succeed), NOT a fallback chain.
    const usdPerOz = priceOf(
      await resolveProvider("stooq").fetchPrice({
        assetId: "metal-spot",
        symbol: STOOQ_METAL_SYMBOL[metal],
        currency: "USD",
        nowIso,
      }),
    );
    if (usdPerOz === null) {
      return null;
    }
    const eurPerUsd = priceOf(
      await resolveProvider("ecb").fetchPrice({
        assetId: "fx",
        symbol: "USD",
        currency: "EUR",
        nowIso,
      }),
    );
    if (eurPerUsd === null) {
      return null;
    }
    return usdPerOz * eurPerUsd;
  } catch {
    return null;
  }
}
