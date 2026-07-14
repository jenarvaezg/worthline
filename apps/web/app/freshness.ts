/**
 * Home freshness, in product language (#896, P0-1 front of #783).
 *
 * With the GET cache-only and the daily crons carrying freshness (#895), the home
 * must say WHEN the data last updated — calmly, and without a shred of jargon
 * (no "cron", no UTC, no "caído"). This pure module turns one "última
 * actualización" instant + now into:
 *
 *  - an always-visible, discreet stamp ("Actualizado hace 15 h"); and
 *  - a `stale` flag that trips ONLY when the freshest datum outran the automatic
 *    window — i.e. an update was missed — so the ≤~12 h normal case never nags.
 *
 * The threshold is deliberately above the ~12 h gap between the two daily passes
 * with room for cron jitter, and below a full day so a genuinely missed pass is
 * caught. It is a single named constant on purpose — afinable per #785/#788.
 *
 * Pure: no React, no DB, no `new Date()` besides arithmetic on the two supplied
 * instants — so the wording and the threshold stay unit-testable.
 */

/**
 * Hours after which the home shows the soft "no pudimos actualizar" alert.
 * The daily crons run ~12 h apart, so a datum older than this means a pass did
 * not run. Kept > 12 (the window) and < 24 (a full day) with margin for jitter.
 */
export const FRESHNESS_STALE_THRESHOLD_HOURS = 16;

export interface FreshnessView {
  /**
   * The calm es-ES stamp ("Actualizado hace 15 h"), always shown when there is
   * any update timestamp. `null` when nothing has been recorded yet (a brand-new
   * or empty portfolio) so the caller renders no stamp at all.
   */
  stampLabel: string | null;
  /**
   * True when the freshest datum is older than the automatic-update window — the
   * only case that surfaces the gentle alert with the "Actualizar" action.
   */
  stale: boolean;
}

/**
 * The freshest SUCCESSFUL price-cache fetch instant, or `null` when none.
 *
 * The price cache is the home's "última actualización" source (#896): the
 * twice-daily cron (#895) re-stamps every priced holding and connected-source
 * valuation as it syncs, and the manual "Actualizar" (#405/#406) bumps it too —
 * so its newest `fetchedAt` is when the data last refreshed, and a manual refresh
 * moves it forward (clearing the alert). A purely-manual portfolio has no priced
 * rows → `null` → no stamp (nothing auto-updates).
 *
 * Only `freshnessState: "fresh"` rows count. A failed/stale fetch bumps its
 * row's `fetchedAt` to now while keeping the OLD price (packages/pricing), so
 * counting it would make the stamp claim "Actualizado hace un momento" when
 * nothing actually refreshed — and mute the very alert this feature exists to
 * raise. Excluding them means: if a whole automatic pass is missed (no writes at
 * all), every row keeps its last-good time and ages into the stale alert — the
 * primary case. A provider failure that DID run is left to the data-health engine
 * (#665). `"manual"` rows are excluded for the same reason (the "Actualizar"
 * action only refetches provider-backed holdings, so it could not clear them).
 *
 * Deliberately NOT the snapshot capture time: the cache-only GET synthesizes an
 * unpersisted "today" point stamped at now (#895), which would peg freshness to
 * "hace un momento" forever. ISO-8601 UTC strings sort in time order, so a plain
 * string max suffices.
 */
export function latestFetchedAt(
  prices: ReadonlyArray<{ fetchedAt: string; freshnessState: string }>,
): string | null {
  return prices.reduce<string | null>(
    (latest, price) =>
      price.freshnessState === "fresh" && (latest === null || price.fetchedAt > latest)
        ? price.fetchedAt
        : latest,
    null,
  );
}

const HOUR_MS = 3_600_000;

/** The relative es-ES age phrase, calm and coarse: moment → hours → ayer → días. */
function agePhrase(ageMs: number): string {
  if (ageMs < HOUR_MS) return "hace un momento";
  const hours = Math.floor(ageMs / HOUR_MS);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}

/**
 * Derive the home freshness view from the last data-update instant and now.
 *
 * @param updatedAtIso - ISO timestamp of the most recent successful data update
 *   (from `latestFetchedAt` over the price cache), or `null` when nothing has
 *   been recorded yet.
 * @param nowIso - ISO "now".
 */
export function deriveFreshness(
  updatedAtIso: string | null,
  nowIso: string,
): FreshnessView {
  if (!updatedAtIso) {
    return { stampLabel: null, stale: false };
  }

  // Clamp negatives (clock skew / a future stamp) to zero: "hace un momento",
  // never stale — we never accuse fresh data of being old.
  const ageMs = Math.max(
    0,
    new Date(nowIso).getTime() - new Date(updatedAtIso).getTime(),
  );

  return {
    stampLabel: `Actualizado ${agePhrase(ageMs)}`,
    stale: ageMs >= FRESHNESS_STALE_THRESHOLD_HOURS * HOUR_MS,
  };
}
