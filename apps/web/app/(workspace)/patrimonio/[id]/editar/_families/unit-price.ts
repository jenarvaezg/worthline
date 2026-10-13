/**
 * A unit price as a ficha prints it: the ledger's price voice (`formatPrice`, up to
 * eight decimals and no padding zeros), masked in privacy mode, then the currency's
 * mark. The investment header's «a 120 €» and a Binance token's «0,00001 € / ud.»
 * read the same way (#1849).
 *
 * Never through a money formatter: those round to the céntimo, and a token worth a
 * fraction of one read «0 € / ud.» on a balance worth tens of euros.
 */

import { currencyMark } from "@web/asistente/document-figures";
import type { CurrencyCode, DecimalString } from "@worthline/domain";
import { formatPrice, maskMoneyString } from "@worthline/domain";

export function fichaUnitPrice(
  price: DecimalString,
  currency: CurrencyCode,
  privacyMode: boolean,
): string {
  const formatted = formatPrice(price);
  const shown = privacyMode ? maskMoneyString(formatted) : formatted;
  return `${shown} ${currencyMark(currency)}`;
}
