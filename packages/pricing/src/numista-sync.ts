/**
 * Numista sync orchestration (PRD #160 / #163, ADR 0017).
 *
 * Turns a user's collected coins into position drafts ready to persist. For each
 * coin it resolves the two candidate values — the melt value (composition ×
 * weight × metal spot) and Numista's per-grade numismatic estimate — and leaves
 * the `max(metal, numismatic)` decision to the domain (`coinValue`). Both
 * candidates are position totals (× quantity) so they compare on the same basis.
 *
 * Every external dependency is injected, so this is a pure unit of work testable
 * without the network: the web action wires the real readers (with the API key +
 * token) and a Stooq/ECB spot resolver. Type details and per-metal spot are
 * deduped to stay within Numista's request cap.
 */

import type { SourcePosition } from "@worthline/domain";

import { ecbProvider } from "./ecb";
import type { MetalKind } from "./metal";
import { metalValueMinor, parseComposition, STOOQ_METAL_SYMBOL } from "./metal";
import { mapCollectedItem, numismaticEstimateMinor } from "./numista";
import type { NumistaCollectedItem, NumistaPrices, NumistaTypeDetail } from "./numista";
import { stooqProvider } from "./stooq";

/** A position ready to persist — the store assigns its id + sourceId. */
export type PositionDraft = Omit<SourcePosition, "id" | "sourceId">;

/** The external reads the sync needs, injected for testability. */
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

export async function syncNumistaCollection(
  deps: NumistaSyncDeps,
  nowIso: string,
): Promise<PositionDraft[]> {
  const items = await deps.listItems();

  const detailByType = new Map<number, NumistaTypeDetail>();
  const spotByMetal = new Map<MetalKind, number | null>();
  const drafts: PositionDraft[] = [];

  for (const item of items) {
    const base = mapCollectedItem(item);
    const typeId = item.type.id;

    let detail = detailByType.get(typeId);
    if (!detail) {
      detail = await deps.typeDetail(typeId);
      detailByType.set(typeId, detail);
    }

    const composition = parseComposition(detail.compositionText);

    let spot: number | null = null;
    if (composition.metal !== null) {
      if (!spotByMetal.has(composition.metal)) {
        spotByMetal.set(composition.metal, await deps.spotPerOzEur(composition.metal));
      }
      spot = spotByMetal.get(composition.metal) ?? null;
    }

    const metalValue = metalValueMinor({
      metal: composition.metal,
      finenessMillis: composition.finenessMillis,
      weightGrams: detail.weightGrams,
      quantity: item.quantity,
      spotPerOzEur: spot,
    });

    let numismaticValue: number | null = null;
    // null until we actually read an estimate — drives the long-TTL refetch gate.
    let numismaticFetchedAt: string | null = null;
    if (base.issueId !== null && base.grade) {
      const priced = await deps.prices(typeId, base.issueId);
      const perCoin = priced ? numismaticEstimateMinor(priced.prices, base.grade) : null;
      // The estimate is per single coin; a position of N coins is worth N times it.
      numismaticValue = perCoin === null ? null : perCoin * item.quantity;
      numismaticFetchedAt = nowIso;
    }

    drafts.push({
      externalId: String(item.id),
      catalogueId: base.catalogueId,
      issueId: base.issueId,
      name: base.name,
      grade: base.grade,
      quantity: base.quantity,
      year: base.year,
      liquidityTier: "illiquid",
      metal: composition.metal,
      finenessMillis: composition.finenessMillis,
      weightGrams: detail.weightGrams,
      purchaseDate: base.purchaseDate,
      metalValueMinor: metalValue,
      numismaticValueMinor: numismaticValue,
      numismaticFetchedAt,
      purchasePriceMinor: base.purchasePriceMinor,
      currency: base.currency,
    });
  }

  return drafts;
}

/** A provider result that carries a usable numeric price. */
function priceOf(
  result: Awaited<ReturnType<typeof stooqProvider.fetchPrice>>,
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
    const usdPerOz = priceOf(
      await stooqProvider.fetchPrice({
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
      await ecbProvider.fetchPrice({
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
