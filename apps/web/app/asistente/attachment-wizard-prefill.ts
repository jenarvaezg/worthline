import type { ExtractedPosition } from "./attachment-extraction-contract";

/**
 * The bridge from an extracted attachment position to the add-holding wizard
 * (#989, PRD #865). It builds ONLY the URL prefill state the simple wizard
 * already reads (`search-state.ts`): no holding is written from the chat — the
 * user lands on the wizard with the fields filled and confirms through its
 * existing seam.
 *
 * A broker/portfolio position maps to the investment drawer's "Cotiza en bolsa"
 * (fund) group: the one whose fields — name, provider symbol, euro balance and
 * unit price — line up with what the extractor produces (name, ticker, market
 * value, units). The user reviews and can switch the drawer; nothing is
 * committed until the wizard's own submit.
 *
 * Insufficient data is never invented: with no euro value the saldo stays blank,
 * and without positive units the unit price stays blank, so the wizard leaves
 * the field pending instead of guessing.
 *
 * A VALUE-ONLY row (neither símbolo nor participaciones on screen, the ordinary
 * shape of a bank's composition tab) lands as the wizard's own value-only encoding: the
 * total as the unit price, so the wizard derives 1 participación (#1325, ADR 0006 — an
 * investment is always units × price, and putting the value up to date later is editing
 * that price). The gate is the SAME one the chat tool applies, and for the same reason:
 * only a row with no ticker may do this, because the moment a real quote can arrive the
 * single fake unit would revalue to one share's NAV. A row that names a symbol but
 * prints no units therefore leaves the price blank and the wizard asks.
 */

const WIZARD_PATH = "/patrimonio/anadir";
const WIZARD_DRAWER = "inversion";
const WIZARD_INSTRUMENT = "fund";

/**
 * Render a finite number as a wizard money/price field value. Plain machine
 * decimals (dot separator, no grouping) round-trip through the wizard's es-ES
 * normalizer, and rounding to 1e-6 strips binary-float dust from the division.
 */
function toFieldValue(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/** The wizard prefill params for one extracted position (see module doc). */
export function buildWizardPrefillParams(
  position: ExtractedPosition,
): Record<string, string> {
  const params: Record<string, string> = {
    instrument: WIZARD_INSTRUMENT,
    invMode_fund: "saldo",
    name_fund: position.name,
    simpleDrawer: WIZARD_DRAWER,
    ...(position.ticker === undefined ? {} : { symbol_fund: position.ticker }),
  };

  const hasValue =
    Number.isFinite(position.marketValueEur) && position.marketValueEur > 0;
  if (hasValue) {
    params.saldo_fund = toFieldValue(position.marketValueEur);
  }

  // Units ride into this instrument as the derived unit price (the wizard has no
  // direct units field in the saldo path; it recomputes units = saldo ÷ price).
  const units = position.units;
  if (hasValue && units !== undefined && Number.isFinite(units) && units > 0) {
    params.price_fund = toFieldValue(position.marketValueEur / units);
  } else if (hasValue && units === undefined && position.ticker === undefined) {
    // Value-only: the total IS the price of the single participación (see module doc).
    params.price_fund = toFieldValue(position.marketValueEur);
  }

  return params;
}

/** A ready-to-navigate href to the wizard, prefilled from an extracted position. */
export function wizardPrefillHref(position: ExtractedPosition): string {
  const query = new URLSearchParams(buildWizardPrefillParams(position));
  return `${WIZARD_PATH}?${query.toString()}`;
}
