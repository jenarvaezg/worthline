import type { InvestmentOperation } from "@worthline/domain";
import { BASE_CURRENCY, maskMoneyString } from "@worthline/domain";

/**
 * How an operation's unit price reads in the ledger table (#1401).
 *
 * Three states, and the point is that they are told apart:
 *
 * - a euro operation: one figure, nothing else to say;
 * - a CONVERTED one: the euros the engine folded, plus the apunte the bank stated
 *   («8,00 USD») underneath — the whole reason the original is persisted, and what
 *   lets a user reconcile a row against a statement in dollars;
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

export function readOperationPrice(
  operation: InvestmentOperation,
  privacyMode: boolean,
): OperationPriceReading {
  const read = (value: string) => (privacyMode ? maskMoneyString(value) : value);

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
