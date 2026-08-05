/**
 * How a figure READ OFF A DOCUMENT is printed on a proposal card (#1373, #1374).
 *
 * One home for three formatters that must not drift, because the whole point of the
 * cards they serve is that the user can hold the paper next to the screen and see the
 * same numbers. The reconcile row and the operation line both print participaciones,
 * a unit price and an amount; before this module they each had their own `Intl`
 * instances, which is exactly how «125,50 €» becomes «126 €» in one card and not the
 * other.
 *
 * Pure and I/O-free (`docs/interaction-patterns.md`, ADR 0036).
 */

import { formatMoneyMinor, formatMoneyMinorExact, formatUnits } from "@worthline/domain";

/**
 * Money as the document states it: whole euros in the app's reading voice
 * (`formatMoneyMinor`), and the cents shown whenever there are any. A figure the
 * user is checking against a PDF may not be rounded away — 125,50 € printed as
 * «126 €» is the same class of lie these cards exist to stop (#1315, #1329) — but a
 * round 125 € does not have to grow a «,00» either.
 */
export function formatDocumentMoney(amountMinor: number, currency = "EUR"): string {
  const money = { amountMinor, currency };
  return amountMinor % 100 === 0 ? formatMoneyMinor(money) : formatMoneyMinorExact(money);
}

const unitPrice = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 });

/**
 * es-ES participaciones — the domain's own reading voice (six decimals), reached
 * through here so a card can hand it either the extraction's number or the plan's
 * decimal string without every caller remembering the cast.
 */
export function formatDocumentUnits(units: number | string): string {
  return formatUnits(String(units));
}

/**
 * es-ES unit price. Four decimals: a derived NAV (125 € ÷ 5,92 part.) is periodic,
 * and the four decimals a fund quotes are the reading voice — six would print noise
 * the document does not contain.
 */
export function formatDocumentUnitPrice(price: number | string): string {
  const value = Number(price);
  return Number.isFinite(value) ? unitPrice.format(value) : String(price);
}
