/**
 * Price-refresh presentation helpers (issue #303).
 *
 * Surface, for derived investment holdings, WHEN their cached unit price was last
 * refreshed and by WHICH source. Two surfaces share these pure formatters:
 *  - the /patrimonio balance board enriches the derived-value badge's native
 *    `title` hover with a RELATIVE date ("precio de hace 2 días, vía Yahoo");
 *  - the holding detail (/patrimonio/[id]/editar) says, under the price, where it
 *    comes from and the day it is FROM ("cotización Yahoo · 11/10/2026", #1828).
 *
 * Dates render in es-ES; the raw source code maps to a short display label. Pure
 * functions only — no React, no DB — so both server components stay thin glue and
 * the wording is unit-testable.
 */

// The leaf date formatter, not the domain barrel's: the board row that imports this
// module is a client island, and string slicing is not worth the barrel.
import { formatIsoDayEs } from "@web/asistente/iso-day-es";
import type { InvestmentPriceOrigin, PriceSource } from "@worthline/domain";

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
 * The line under a holding's price on its ficha (#1828): where the price comes
 * from and of when — «cotización Yahoo · 11/10/2026», «precio a mano · 03/10/2026»,
 * «sin precio: se valora a lo que costó». It only words the origin the valuation
 * engine handed back with the price; it never infers one. A day nobody can vouch
 * for is left out rather than guessed. It replaced the «Precio actualizado el …»
 * caption, which dated a quote by its LAST FETCH — a failed refresh included.
 *
 * A failed refresh is said in words (#1731 review): the kept quote «no se pudo
 * actualizar», and a hand-set price or the cost stands in because the quote failed.
 * The day stays the price's own; the failed attempt never lends it one.
 */
export function priceOriginCaption(origin: InvestmentPriceOrigin): string {
  if (origin.kind === "cost") {
    return origin.refreshFailed
      ? "sin precio: falló la cotización y se valora a lo que costó"
      : "sin precio: se valora a lo que costó";
  }
  const what =
    origin.kind === "manual"
      ? "precio a mano"
      : origin.provider === null || origin.provider === "manual"
        ? "cotización guardada"
        : `cotización ${priceSourceLabel(origin.provider)}`;
  const failure = !origin.refreshFailed
    ? null
    : origin.kind === "quote"
      ? "no se pudo actualizar"
      : "falló la cotización automática";
  return [what, origin.asOf === null ? null : formatIsoDayEs(origin.asOf), failure]
    .filter((part) => part !== null)
    .join(" · ");
}
