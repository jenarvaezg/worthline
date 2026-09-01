import type { ValuationFreshness } from "@worthline/db";
import type { AssetPrice, CoinPosition, SourcePosition } from "@worthline/domain";
import { isPriceStale } from "@worthline/domain";
import type {
  MetalKind,
  RevaluedPosition,
  RevaluePassOutcome,
  RevaluePosition,
} from "@worthline/pricing";

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
 * A pass's work survives the pass (#1739), two ways. It is written in tranches as
 * it goes (`revalue` gets a `checkpoint` for that), because ~80 sequential Numista
 * calls can die with NO exception to catch — the request budget runs out and the
 * process is gone. And a failure persists what the pass had resolved before it
 * marks the source stale, instead of the `[]` it used to write. Those coins were
 * already bought; throwing their stamps away while (rightly) leaving the source
 * stale meant the next pass re-bought the whole collection and died at the same
 * coin — 440 `getPrices` calls in one day over 78 coins, with nothing to show.
 *
 * A tranche deliberately does NOT stamp the freshness row (it persists with
 * `null`): the gate reads that row's `fetchedAt` and ignores `freshnessState`, so
 * stamping it mid-pass would make an unfinished collection read as valued today —
 * worst of all on a source that was never valued, where the pass still has every
 * coin to buy. Untouched, the source stays due until the pass actually ends.
 *
 * Pure orchestration: the store reads/writes and the Numista/Yahoo network are
 * injected, so the gate and outage paths are testable without I/O.
 */

/** A connected coin source to consider, with its current valuation freshness. */
export interface CoinSourceRef {
  sourceId: string;
  /** Current `numista`-source freshness entry, or null when never valued. */
  freshness: AssetPrice | null;
}

export interface RefreshCoinValuationsInput {
  /** ISO "now" for the staleness gate + the fresh fetched-at stamp. */
  nowIso: string;
  /** The connected coin sources to consider. */
  sources: CoinSourceRef[];
  /** Read a source's stored positions. */
  readPositions: (sourceId: string) => SourcePosition[] | Promise<SourcePosition[]>;
  /** Run the live valuation refresh for a source (mints token + fetches). Returns
   *  what the pass resolved plus the failure that cut it short, so a half-finished
   *  pass still hands back the coins it paid for (#1739); may still throw when it
   *  fails before valuing anything (bad credentials / token mint). `checkpoint` is
   *  the pass's way to bank a tranche mid-flight — see the module note. */
  revalue: (
    sourceId: string,
    positions: RevaluePosition[],
    nowIso: string,
    checkpoint: (updates: RevaluedPosition[]) => Promise<void>,
  ) => Promise<RevaluePassOutcome>;
  /** Persist a revaluation outcome (candidate updates + freshness row). A `null`
   *  freshness banks a mid-pass tranche and leaves the row untouched (#1739). */
  persist: (
    sourceId: string,
    updates: RevaluedPosition[],
    freshness: ValuationFreshness | null,
  ) => void | Promise<void>;
}

export interface RefreshCoinValuationsResult {
  /** One human-readable message per source that failed to refresh. */
  errors: string[];
}

/** Map a stored coin position to the valuation-refresh input shape. */
function toRevaluePosition(position: CoinPosition): RevaluePosition {
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

/** The human-readable reason a thrown failure gives, for the staleness banner. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown coin-refresh error";
}

export async function refreshStaleCoinValuations(
  input: RefreshCoinValuationsInput,
): Promise<RefreshCoinValuationsResult> {
  const errors: string[] = [];

  for (const source of input.sources) {
    if (!isPriceStale(source.freshness, input.nowIso)) {
      continue;
    }

    const positions = (await input.readPositions(source.sourceId))
      .filter((position): position is CoinPosition => position.kind === "coin")
      .map(toRevaluePosition);

    // Bank a tranche mid-pass: keep the coins already resolved, and leave the
    // freshness row untouched — the pass is not done, so the source is still due.
    const checkpoint = async (banked: RevaluedPosition[]): Promise<void> => {
      await input.persist(source.sourceId, banked, null);
    };

    // What the pass resolved, and what stopped it (if anything). A throw means it
    // fell over BEFORE valuing anything — a missing credential, a token mint — so
    // `updates` stays empty and there is nothing left to keep. The happy-path write
    // stays inside the try: a failed write is a failed refresh too, and is reported
    // as one below instead of escaping.
    let updates: RevaluedPosition[] = [];
    let failureMessage: string;
    try {
      const outcome = await input.revalue(
        source.sourceId,
        positions,
        input.nowIso,
        checkpoint,
      );
      updates = outcome.updates;
      if (outcome.error === null) {
        await input.persist(source.sourceId, updates, {
          fetchedAt: input.nowIso,
          freshnessState: "fresh",
        });
        continue;
      }
      failureMessage = outcome.error.message;
    } catch (err) {
      failureMessage = messageOf(err);
    }

    // Outage / bad credentials: persist the coins the pass DID resolve (their
    // estimates are already paid for), keep the last-known value for the rest, and
    // mark the source stale — leaving the prior fetched-at so the next pass retries,
    // now starting from those stamps. The reason rides the banner via `errors`.
    errors.push(failureMessage);
    try {
      await input.persist(source.sourceId, updates, {
        // The prior stamp, so the source stays stale and the next pass retries.
        fetchedAt: source.freshness?.fetchedAt ?? input.nowIso,
        freshnessState: "stale",
        staleReason:
          "No se pudo actualizar la valoración de la colección Numista (revisa la conexión).",
      });
    } catch (err) {
      // The store itself is unwell (this is also the retry of a happy-path write
      // that just failed). Report it and move to the next source: one broken
      // source must not stop the others from refreshing, and this pass is awaited
      // by the dashboard render.
      errors.push(messageOf(err));
    }
  }

  return { errors };
}
