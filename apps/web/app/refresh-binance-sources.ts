import type { AssetPrice } from "@worthline/domain";
import { isPriceStale } from "@worthline/domain";
import type { TokenPositionDraft } from "@worthline/pricing";

/**
 * Binance live-revalue orchestration (PRD #245 S4, issue #249, ADR 0007/0021).
 *
 * The Binance counterpart of `refreshStaleCoinValuations`: where that refreshes
 * connected coin collections, this keeps connected Binance sources current. Each
 * source's primary holding carries one `binance`-source price-cache row whose
 * daily TTL the dashboard's stale-price pass selects; when it lapses (or was
 * never valued) this re-reads the account balances and re-values them LIVE
 * (balance × live unit price — never a frozen number, ADR 0021), then persists.
 *
 * Unlike Numista's rate-capped estimate, Binance is valued live on every refresh,
 * so this layer only gates on freshness and handles outages: a failed re-sync
 * keeps the last-known value and marks the source stale (so it retries next pass)
 * rather than throwing — and never zeroes the holding. The reason is surfaced via
 * the returned `errors` for the staleness banner.
 *
 * Pure orchestration: the store reads/writes and the Binance/CoinGecko network are
 * injected, so the gate and outage paths are testable without I/O.
 */

/** A connected Binance source to consider, with its current valuation freshness. */
export interface BinanceSourceRef {
  sourceId: string;
  /** Current `binance`-source freshness entry, or null when never valued. */
  freshness: AssetPrice | null;
}

export interface RefreshBinanceSourcesInput {
  /** ISO "now" for the staleness gate + the fresh fetched-at stamp. */
  nowIso: string;
  /** The connected Binance sources to consider. */
  sources: BinanceSourceRef[];
  /** Re-read the account balances and re-price them live for a source;
   *  throws on a hard failure (bad credentials / total outage). */
  reSync: (sourceId: string) => Promise<TokenPositionDraft[]>;
  /** Persist a successful re-sync (replace positions + stamp the freshness row fresh). */
  persistFresh: (sourceId: string, drafts: TokenPositionDraft[]) => void;
  /** Persist an outage: keep the last-known value (no position changes) and mark
   *  the source stale, carrying the PRIOR fetched-at so the next pass retries it. */
  persistStale: (sourceId: string, lastFetchedAt: string | null, reason: string) => void;
}

export interface RefreshBinanceSourcesResult {
  /** One human-readable message per source that failed to refresh. */
  errors: string[];
}

export async function refreshStaleBinanceSources(
  input: RefreshBinanceSourcesInput,
): Promise<RefreshBinanceSourcesResult> {
  const errors: string[] = [];

  for (const source of input.sources) {
    if (!isPriceStale(source.freshness, input.nowIso)) {
      continue;
    }

    // Only the NETWORK re-read is an "outage": guard it alone so a real Binance
    // failure keeps the last-known value (no position updates) and marks the source
    // stale, carrying the prior fetched-at so the next daily pass retries it.
    let drafts: TokenPositionDraft[];
    try {
      drafts = await input.reSync(source.sourceId);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "Unknown Binance-refresh error");
      input.persistStale(
        source.sourceId,
        source.freshness?.fetchedAt ?? null,
        "No se pudo actualizar la valoración de Binance (revisa la conexión).",
      );
      continue;
    }

    // The balances WERE read: persist them. A local write failure here is NOT an
    // outage (the positions may already be committed), so it must not masquerade as
    // one nor mark the source stale — record it distinctly and never throw (the
    // freshness row is left for the next pass to re-stamp).
    try {
      input.persistFresh(source.sourceId, drafts);
    } catch (err) {
      errors.push(
        err instanceof Error
          ? `No se pudo guardar la valoración de Binance: ${err.message}`
          : "No se pudo guardar la valoración de Binance.",
      );
    }
  }

  return { errors };
}
