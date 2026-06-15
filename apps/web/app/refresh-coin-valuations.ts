import type { AssetPrice, SourcePosition } from "@worthline/domain";
import { selectStalePrices } from "@worthline/domain";
import type { ValuationFreshness } from "@worthline/db";
import type { MetalKind, RevaluedPosition, RevaluePosition } from "@worthline/pricing";

/**
 * Coin-valuation refresh orchestration (PRD #160 / #166, ADR 0017).
 *
 * The decoupled counterpart of `refreshAndPersistStalePrices`: where that refreshes
 * investment prices, this refreshes connected coin sources. Each source's
 * coin-collection asset carries one `numista`-source price-cache row whose daily
 * TTL the dashboard's stale-price pass selects; when it lapses (or was never
 * valued) this re-derives the collection's coin values and persists them.
 *
 * Numista's per-grade estimate is rate-capped, so the heavy decision (which coins
 * to refetch on the long TTL) lives in the injected `revalue`; this layer only
 * gates on freshness and handles outages: a failed refresh keeps the last-known
 * value and marks the source stale (so it retries next pass) rather than throwing,
 * and the reason is surfaced via the returned `errors` for the staleness banner.
 *
 * Pure orchestration: the store reads/writes and the Numista/Stooq network are
 * injected, so the gate and outage paths are testable without I/O.
 */

/** A connected coin source to consider, with its current valuation freshness. */
export interface CoinSourceRef {
  sourceId: string;
  /** The materialized coin-collection asset id (carries the freshness row). */
  assetId: string;
  /** Current `numista`-source freshness entry, or null when never valued. */
  freshness: AssetPrice | null;
}

export interface RefreshCoinValuationsInput {
  /** ISO "now" for the staleness gate + the fresh fetched-at stamp. */
  nowIso: string;
  /** The connected coin sources to consider. */
  sources: CoinSourceRef[];
  /** Read a source's stored positions. */
  readPositions: (sourceId: string) => SourcePosition[];
  /** Run the live valuation refresh for a source (mints token + fetches);
   *  throws on a hard failure (bad credentials / total outage). */
  revalue: (
    sourceId: string,
    positions: RevaluePosition[],
    nowIso: string,
  ) => Promise<RevaluedPosition[]>;
  /** Persist a revaluation outcome (candidate updates + freshness row). */
  persist: (
    sourceId: string,
    updates: RevaluedPosition[],
    freshness: ValuationFreshness,
  ) => void;
}

export interface RefreshCoinValuationsResult {
  /** One human-readable message per source that failed to refresh. */
  errors: string[];
}

/** Map a stored position to the valuation-refresh input shape. */
function toRevaluePosition(position: SourcePosition): RevaluePosition {
  return {
    id: position.id,
    typeId: Number(position.catalogueId),
    issueId: position.issueId,
    grade: position.grade,
    quantity: position.quantity,
    metal: position.metal as MetalKind | null,
    finenessMillis: position.finenessMillis,
    weightGrams: position.weightGrams,
    metalValueMinor: position.metalValueMinor,
    numismaticValueMinor: position.numismaticValueMinor,
    numismaticFetchedAt: position.numismaticFetchedAt,
  };
}

/** Whether a source's valuation needs refreshing: never valued, or past the
 *  per-source TTL (ADR 0007's canonical rule applied to the `numista` row). */
function isStale(freshness: AssetPrice | null, nowIso: string): boolean {
  if (freshness === null) return true;
  return selectStalePrices([freshness], nowIso).length > 0;
}

export async function refreshStaleCoinValuations(
  input: RefreshCoinValuationsInput,
): Promise<RefreshCoinValuationsResult> {
  const errors: string[] = [];

  for (const source of input.sources) {
    if (!isStale(source.freshness, input.nowIso)) {
      continue;
    }

    const positions = input.readPositions(source.sourceId).map(toRevaluePosition);

    try {
      const updates = await input.revalue(source.sourceId, positions, input.nowIso);
      input.persist(source.sourceId, updates, {
        fetchedAt: input.nowIso,
        freshnessState: "fresh",
      });
    } catch (err) {
      // Outage / bad credentials: keep the last-known value (no position updates)
      // and mark the source stale — leaving the prior fetched-at so the next pass
      // retries it. The reason rides the staleness banner via `errors`.
      errors.push(err instanceof Error ? err.message : "Unknown coin-refresh error");
      input.persist(source.sourceId, [], {
        fetchedAt: source.freshness?.fetchedAt ?? input.nowIso,
        freshnessState: "stale",
        staleReason:
          "No se pudo actualizar la valoración de la colección Numista (revisa la conexión).",
      });
    }
  }

  return { errors };
}
