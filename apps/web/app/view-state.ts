import type { NetWorthFraming } from "@worthline/domain";

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

/** The Vista framing toggle (#518): net worth (default) ↔ liquid net worth. */
export const FRAMING_VIEW_PARAM: ViewParamSpec<NetWorthFraming> = {
  key: "view",
  allowed: ["total", "liquid"],
  fallback: "total",
};
