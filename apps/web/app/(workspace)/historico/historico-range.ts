/**
 * /historico temporal window (#1535).
 *
 * Default is the last 12 months (`1y`, omitted from the URL). Expanding to
 * 3A/5A/Todo is a real navigation — the dataset is the cost this ticket
 * bounds, so the alternatives are not preloaded (interaction-patterns §2
 * exception: changing the window changes the dataset).
 */

import { type ViewParamSpec, writeViewParam } from "@web/view-state";
import type { CompositionRange } from "@worthline/domain";
import { COMPOSITION_RANGES, rangeStartMonthKey } from "@worthline/domain";

export const HISTORICO_RANGE_VIEW_PARAM: ViewParamSpec<CompositionRange> = {
  allowed: COMPOSITION_RANGES,
  fallback: "1y",
  key: "range",
};

export const HISTORICO_RANGE_LABELS: Record<CompositionRange, string> = {
  "1y": "1A",
  "3y": "3A",
  "5y": "5A",
  all: "Todo",
};

export function parseHistoricoRangeParam(
  value: string | string[] | undefined,
): CompositionRange {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1y" || raw === "3y" || raw === "5y" || raw === "all" ? raw : "1y";
}

/** Inclusive `from` date-key for the snapshot reads; `undefined` means unbounded. */
export function historicoWindowFrom(
  today: string,
  range: CompositionRange,
): string | undefined {
  const monthKey = rangeStartMonthKey(today, range);
  return monthKey === null ? undefined : `${monthKey}-01`;
}

export function historicoRangeHref(search: string, range: CompositionRange): string {
  return `/historico${writeViewParam(search, HISTORICO_RANGE_VIEW_PARAM, range)}`;
}

export function searchFromParams(
  params: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw !== undefined) query.set(key, raw);
  }
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}
