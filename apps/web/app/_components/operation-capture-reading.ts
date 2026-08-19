import type { InvestmentOperation, MoneyMinor } from "@worthline/domain";
import {
  BASE_CURRENCY,
  formatMoneyMinorPrivacy,
  formatPrice,
  maskMoneyString,
} from "@worthline/domain";

/**
 * How an operation's unit price reads in the ledger table (#1401).
 *
 * Three states, and the point is that they are told apart:
 *
 * - a euro operation: one figure, nothing else to say;
 * - a CONVERTED one: the euros the engine folded, plus the apunte the bank stated
 *   («8 USD») underneath — the whole reason the original is persisted, and what
 *   lets a user reconcile a row against a statement in dollars. Figures go through
 *   {@link formatPrice} so a leftover 20-dp NAV still reads at 8 (#1467);
 * - a row still in its own currency: the optimistic row the island adds before the
 *   redirect, when the rate is not known yet. It is NOT euros, so it never renders as
 *   a bare number — the currency rides with it until the server settles the figure.
 *
 * Pure so the reading unit-tests without a DOM, and shared by the table's cell so the
 * three states cannot drift apart in markup.
 */
export interface OperationPriceReading {
  /** The figure the price column shows. */
  price: string;
  /** The apunte to show underneath, or null when there is nothing to add. */
  capture: string | null;
}

/**
 * The fees the operation was charged, as its own reading: the euros, plus what the bank
 * charged when that was another currency. Same three states as the price — a row shows
 * BOTH captured figures or neither, because showing the price in dollars next to fees in
 * euros invites reading the euro figure as dollars too.
 *
 * Null when there were no fees: an empty cell is the existing convention («—»), and «0,00
 * USD» is noise.
 */
export function readOperationFees(
  operation: InvestmentOperation,
  privacyMode: boolean,
): { fees: MoneyMinor; capture: string | null } | null {
  if (operation.feesMinor === 0 && (operation.capture?.feesMinor ?? 0) === 0) {
    return null;
  }

  const fees = { amountMinor: operation.feesMinor, currency: operation.currency };
  const captured = operation.capture;

  if (captured === undefined || captured.feesMinor === 0) {
    return { capture: null, fees };
  }

  return {
    capture: formatMoneyMinorPrivacy(
      { amountMinor: captured.feesMinor, currency: captured.currency },
      privacyMode,
    ),
    fees,
  };
}

export function readOperationPrice(
  operation: InvestmentOperation,
  privacyMode: boolean,
): OperationPriceReading {
  const read = (value: string) => {
    // Ledger and capture figures share the price voice: es-ES, eight decimals,
    // no padding. Privacy masks that reading so a leftover 20-dp NAV and an
    // 8.00 USD apunte hide the same way (#1467).
    const formatted = formatPrice(value);
    return privacyMode ? maskMoneyString(formatted) : formatted;
  };

  if (operation.capture !== undefined) {
    return {
      capture: `${read(operation.capture.pricePerUnit)} ${operation.capture.currency}`,
      price: read(operation.pricePerUnit),
    };
  }

  return {
    capture: null,
    price:
      operation.currency === BASE_CURRENCY
        ? read(operation.pricePerUnit)
        : `${read(operation.pricePerUnit)} ${operation.currency}`,
  };
}
