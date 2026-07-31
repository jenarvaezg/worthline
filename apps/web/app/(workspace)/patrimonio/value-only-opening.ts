/**
 * The «nacida por valor total» position and what happens when you hand it a
 * market symbol (#1329, residual del review de #1328).
 *
 * An alta that only knows what the holding is WORTH today — the chat alta of
 * #1325, or a wizard user typing the total into the price field — lands as
 * **1 participación × el valor**. That encoding is honest while nothing prices
 * the holding: ADR 0006 says an investment is always units × price, and putting
 * it al día is editing that price.
 *
 * It stops being honest the moment a real quote can arrive. Assigning a
 * `providerSymbol` makes `refreshStalePrices` reprice the position at 1 × NAV,
 * so 574,48 € become ~12 € in silence — and the false unit poisons every later
 * buy on the holding. The alta card already warns «no le asignes un símbolo sin
 * corregir antes los títulos», but nothing enforced it on the editing surface.
 *
 * This module is the detection + the wording, pure: no store, no clock, no
 * network. The action decides (block, or let an acknowledged 1-participación
 * position through) and the form renders the same facts before the user submits.
 */

import type { DecimalString, InvestmentOperation } from "@worthline/domain";
import { multiplyToMinor } from "@worthline/domain";

export interface ValueOnlyOpening {
  /** The single participación's price — which IS the declared total value. */
  pricePerUnit: DecimalString;
  /** That price in minor units: what the holding is worth today. */
  valueMinor: number;
}

/**
 * The live position is EXACTLY the 1-participación opening, or null.
 *
 * Deliberately narrow: one operation, the alta's own opening BUY, one unit. A
 * ledger with a second operation has been curated by a human (or an importer)
 * and is none of this guard's business; a manual 1-unit buy is somebody
 * declaring a real share. `source: "opening"` is what both alta doors stamp, so
 * it is the honest marker of «este número lo puso un alta, no un documento».
 */
export function detectValueOnlyOpening(
  operations: readonly InvestmentOperation[],
): ValueOnlyOpening | null {
  if (operations.length !== 1) return null;
  const opening = operations[0]!;
  if (opening.kind !== "buy" || opening.source !== "opening") return null;
  if (Number.parseFloat(opening.units) !== 1) return null;
  return {
    pricePerUnit: opening.pricePerUnit,
    valueMinor: multiplyToMinor(opening.units, opening.pricePerUnit),
  };
}

/**
 * Cents-precise es-ES euros: this guard exists to compare two figures, and
 * `formatMoneyMinor`'s whole-euro rounding would print «574 € → 12 €» — close
 * enough to read as an approximation of the same number.
 */
function euros(amountMinor: number): string {
  return new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

/** The es-ES label of the acknowledgement checkbox — quoted inside the guard. */
export const VALUE_ONLY_ACK_LABEL = "Es una participación real";

/**
 * What the user reads when the save would trade a declared total for one share's
 * quote. States both figures when the quote is known (the whole point is that
 * the loss is invisible otherwise) and stays honest when it is not.
 */
export function valueOnlySymbolGuardMessage(input: {
  opening: ValueOnlyOpening;
  symbol: string;
  /** The quote the symbol resolves to, when the save already fetched one. */
  quotedPricePerUnit?: string | null;
}): string {
  // The provider's own decimal string ("4.25"), never a user-typed es-ES amount:
  // a shape check, then the domain's exact multiplication — no float cents.
  const quoted =
    typeof input.quotedPricePerUnit === "string" &&
    /^\d+(\.\d+)?$/.test(input.quotedPricePerUnit)
      ? multiplyToMinor("1" as DecimalString, input.quotedPricePerUnit as DecimalString)
      : null;
  const outcome =
    quoted === null
      ? `pasaría a valer lo que cueste UNA participación de «${input.symbol}»`
      : `pasaría a valer ${euros(quoted)} (1 participación × la cotización de «${input.symbol}»)`;
  return (
    `Esta inversión se dio de alta por su valor total: 1 participación × ${euros(input.opening.valueMinor)}. ` +
    `Con símbolo manda la cotización, así que ${outcome}. ` +
    "Corrige antes los títulos y el precio en la operación de apertura — o marca " +
    `«${VALUE_ONLY_ACK_LABEL}» si de verdad tienes una sola participación.`
  );
}

/** The same facts as a heads-up in the form, before anything is submitted. */
export function valueOnlySymbolFormNotice(opening: ValueOnlyOpening): string {
  return (
    `Esta inversión se dio de alta por su valor total: 1 participación × ${euros(opening.valueMinor)}. ` +
    "Si le asignas un símbolo, la cotización mandará y el holding pasará a valer UNA participación: " +
    "corrige antes los títulos y el precio en la operación de apertura."
  );
}
