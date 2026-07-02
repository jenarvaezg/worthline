import type { CompositionRange, NetWorthFraming } from "@worthline/domain";
import { COMPOSITION_RANGES } from "@worthline/domain";

/**
 * Pure URL ⇄ view-state mirror (S2, #518, ADR 0036 / interaction-patterns §3).
 *
 * The foundation the ephemeral view toggles share: an island reads its current
 * value from the URL's query string on load and, on toggle, computes the next
 * query string here and hands it to `history.pushState` — no server round-trip,
 * yet the deep-link and the Back button keep working because the state still
 * lives in the URL. Kept pure (no `window`/`history`) so it unit-tests in the
 * node env while the client island holds only the thin pushState/popstate
 * wiring. Reused by S3 (range/density) and S4 (drill): each surface is one
 * `ViewParamSpec`.
 */

export interface ViewParamSpec<T extends string> {
  /** The query-string key, e.g. `"view"`. */
  readonly key: string;
  /** The allowed values; anything else reads back as the fallback. */
  readonly allowed: readonly T[];
  /**
   * The default value. It is OMITTED from the URL, so toggling back to the
   * default reproduces the clean URL (no stray `?view=total`).
   */
  readonly fallback: T;
}

function toParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

/** The spec's value parsed from a query string (`"?a=b"` or `"a=b"`), or its fallback. */
export function readViewParam<T extends string>(
  search: string,
  spec: ViewParamSpec<T>,
): T {
  const raw = toParams(search).get(spec.key);

  return raw !== null && (spec.allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : spec.fallback;
}

/**
 * The next query string with the spec's key set to `value`, every OTHER param
 * preserved in place, and the key OMITTED when `value` is the fallback. Returns
 * a leading-`"?"` string ready to hand to `pushState`, or `""` when no params
 * remain.
 */
export function writeViewParam<T extends string>(
  search: string,
  spec: ViewParamSpec<T>,
  value: T,
): string {
  const params = toParams(search);

  if (value === spec.fallback) {
    params.delete(spec.key);
  } else {
    params.set(spec.key, value);
  }

  const qs = params.toString();

  return qs ? `?${qs}` : "";
}

/**
 * Window event a view-state island fires right after it `pushState`s a change,
 * so the OTHER islands on the page reconcile with the new URL. `pushState` fires
 * no native event, so two islands that both mirror to the URL (#518 framing,
 * #519 range) cannot otherwise observe each other's writes. Each island
 * dispatches this on toggle and re-reads its value from the URL on hearing it —
 * the URL stays the single source of truth (interaction-patterns §3); the event
 * is only the "it changed, re-read" nudge. Back/Forward already nudge via the
 * native `popstate`, which islands listen to alongside this.
 */
export const VIEW_STATE_CHANGE_EVENT = "worthline:viewstatechange";

/** The Vista framing toggle (#518): net worth (default) ↔ liquid net worth. */
export const FRAMING_VIEW_PARAM: ViewParamSpec<NetWorthFraming> = {
  key: "view",
  allowed: ["total", "liquid"],
  fallback: "total",
};

/**
 * The composition chart's temporal range pills (#144, S3 #519): 1A/3A/5A windows
 * with `all` (full history) as the OMITTED default — matching `parseRangeParam`
 * and `compositionUrl`, so a client toggle reproduces the exact URL the server
 * link used to.
 */
export const RANGE_VIEW_PARAM: ViewParamSpec<CompositionRange> = {
  key: "range",
  allowed: COMPOSITION_RANGES,
  fallback: "all",
};

/** The two exposure-lens values: full portfolio (default) ↔ equity-only. */
export type ExposureLens = "all" | "equity";

/**
 * The /patrimonio exposure section's geography lens (PRD #539 S3, #543): the
 * full-portfolio look-through (default, OMITTED) ↔ the equity-restricted one.
 * The server pre-renders BOTH `lookThroughExposure` results; this only picks
 * which is shown, so toggling costs no round-trip (interaction-patterns §2).
 */
export const EXPOSURE_LENS_VIEW_PARAM: ViewParamSpec<ExposureLens> = {
  key: "exp",
  allowed: ["all", "equity"],
  fallback: "all",
};
