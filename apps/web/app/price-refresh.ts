/**
 * Price-refresh presentation helpers (issue #303).
 *
 * Surface, for derived investment holdings, WHEN their cached unit price was last
 * refreshed and by WHICH source. Two surfaces share these pure formatters:
 *  - the /patrimonio balance board enriches the derived-value badge's native
 *    `title` hover with a RELATIVE date ("precio de hace 2 días, vía Yahoo");
 *  - the holding detail (/patrimonio/[id]/editar) shows a visible caption with an
 *    ABSOLUTE date ("Precio actualizado el 8 jun 2026 · Yahoo").
 *
 * Dates render in es-ES; the raw source code maps to a short display label. Pure
 * functions only — no React, no DB — so both server components stay thin glue and
 * the wording is unit-testable.
 */

import type { PriceSource } from "@worthline/domain";

/**
 * Short es-ES display label for a recorded price source. Investment prices come
 * from `yahoo`/`stooq`/`finect`/`coingecko`; the remaining sources are covered so
 * the map is total (a `manual` quote, the connected `binance`/`numista` feeds, or
 * an `ecb` FX rate) and never falls through to a raw code.
 */
const SOURCE_LABELS: Record<PriceSource, string> = {
  manual: "Manual",
  ecb: "BCE",
  coingecko: "CoinGecko",
  stooq: "Stooq",
  yahoo: "Yahoo",
  finect: "Finect",
  numista: "Numista",
  binance: "Binance",
};

/** The es-ES display label for a recorded price source (#303). */
export function priceSourceLabel(source: PriceSource): string {
  return SOURCE_LABELS[source];
}

/** Whole days between two instants, floored and never negative. */
function daysBetween(fromIso: string, nowIso: string): number {
  const ageMs = new Date(nowIso).getTime() - new Date(fromIso).getTime();
  return Math.max(0, Math.floor(ageMs / 86_400_000));
}

/**
 * A relative es-ES refresh phrase for the board hover: "hoy", "ayer", or "hace N
 * días". Coarse on purpose — the board only needs an at-a-glance recency, the
 * detail caption carries the exact date.
 */
export function relativeRefreshDate(fetchedAtIso: string, nowIso: string): string {
  const days = daysBetween(fetchedAtIso, nowIso);
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}

/** An absolute es-ES date for the detail caption: "8 jun 2026". */
export function absoluteRefreshDate(fetchedAtIso: string): string {
  return new Date(fetchedAtIso).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The board badge's `title` suffix: " · precio de hace 2 días, vía Yahoo". Appended
 * to the existing "Valor calculado (unidades × precio)" hover so one native tooltip
 * carries both (no client JS, ADR 0009). Null when there is no refresh metadata.
 */
export function boardRefreshHover(
  fetchedAtIso: string | null,
  source: PriceSource | null,
  nowIso: string,
): string | null {
  if (!fetchedAtIso || !source) return null;
  return ` · precio de ${relativeRefreshDate(fetchedAtIso, nowIso)}, vía ${priceSourceLabel(source)}`;
}

/**
 * The detail caption text: "Precio actualizado el 8 jun 2026 · Yahoo". Null when
 * there is no refresh metadata (a manual quote or an as-yet-unpriced investment).
 */
export function detailRefreshCaption(
  fetchedAtIso: string | null,
  source: PriceSource | null,
): string | null {
  if (!fetchedAtIso || !source) return null;
  return `Precio actualizado el ${absoluteRefreshDate(fetchedAtIso)} · ${priceSourceLabel(source)}`;
}
