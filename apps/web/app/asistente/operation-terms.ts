/**
 * From an observed dated fact to the terms an operation is written with (#1374).
 * Pure: no store, no clock, no persistence.
 *
 * The whole module is one invariant, the same one the alta solves for (#1315):
 * `importe = participaciones × precio + comisión`. A confirmation states three of
 * those four terms at most, so the missing side is DERIVED from the ones printed and
 * never invented — and when nothing printed can pin the quantity, the operation is
 * refused instead of encoded with a fake participación.
 *
 * That refusal is the sharp edge here, and it is deliberate. On an EXISTING position
 * the «1 participación al importe» encoding of a value-only alta (#1325) is not
 * available: a holding that can be priced would revalue that unit to ONE share's NAV
 * at the next ripple, so 125 € would silently become 21 €, and a holding that cannot
 * would end up with two units and a value read off the last price. Both are the
 * class of lie this lane was opened to stop, so the honest answer is to say which
 * figure is missing.
 */

import { deriveOpeningUnits } from "@web/patrimonio/anadir/investment-units";
import {
  type DecimalString,
  divideUnits,
  formatMoneyMinorExact,
  formatUnits,
  multiplyToMinor,
  normalizeDecimal,
  PRICE_READBACK_DECIMALS,
} from "@worthline/domain";

import type { ExtractedHoldingEvent } from "./attachment-extraction-contract";
import { formatDocumentUnitPrice } from "./document-figures";

export interface OperationTerms {
  /** YYYY-MM-DD, the document's own day. */
  executedAt: string;
  currency: string;
  /** Participaciones as a decimal string: the document's, or derived from its price. */
  units: DecimalString;
  /** The unit price the ledger records. */
  pricePerUnit: DecimalString;
  /** The cash amount the document states, integer minor units. */
  amountMinor: number;
  /**
   * The commission the document PRINTS, integer minor units — including a printed
   * zero, which the card shows as «comisión 0 €». Absent means the document printed
   * none at all, and the card then says nothing about commissions.
   */
  feesMinor?: number;
  /**
   * Honest, never blocking: the printed terms do not add up, or the participaciones
   * had to be derived. There is deliberately no `unitsDerived` flag next to this —
   * a boolean nothing reads is a boolean that can go stale and lie (and the plan read
   * back from the database could not honestly set it), so the derivation speaks
   * through the note the user actually sees.
   */
  notes: string[];
}

export type OperationTermsResolution =
  | { ok: true; terms: OperationTerms }
  | { ok: false; error: string };

/** A major-unit figure the document printed, as exact integer cents. */
function toMinor(amount: number): number {
  return multiplyToMinor(String(amount), "1");
}

/** Integer cents back to a decimal string, for the decimal seam's division. */
function minorToDecimal(amountMinor: number): DecimalString {
  return (amountMinor / 100).toFixed(2);
}

function euros(amountMinor: number, currency: string): string {
  return formatMoneyMinorExact({ amountMinor, currency });
}

/**
 * Cents of slack when reconciling `participaciones × precio impreso + comisión`
 * against the printed amount. It has to SCALE with the quantity: a fund prints its
 * NAV rounded to the decimals it quotes, so the true price is within half of that
 * last decimal, and over 5,92 participaciones a NAV printed as 21,12 € can be off by
 * ~3 cents without anything being wrong. A fixed one-cent tolerance would flag every
 * real confirmation; a tolerance derived from the printed precision flags only the
 * ones that genuinely do not add up.
 */
function reconciliationToleranceMinor(units: number, printedPrice: number): number {
  const decimals = decimalPlaces(printedPrice);
  const halfStep = 0.5 * 10 ** -decimals;
  return Math.ceil(Math.abs(units) * halfStep * 100) + 1;
}

/** How many decimals a printed figure carries — its stated precision. */
function decimalPlaces(value: number): number {
  const [, fraction = ""] = String(value).split(".");
  return fraction.length;
}

const MISSING_QUANTITY =
  "El documento dice el importe pero no las participaciones ni el precio por título, y " +
  "sin una de las dos no puedo anotar la operación: inventarme una participación haría " +
  "que la posición se revalorase al precio de UNA y se comería el importe. Dime las " +
  "participaciones o el precio unitario de la operación, o anótala en las operaciones de " +
  "esa posición, dentro de Patrimonio.";

/**
 * Resolve the observed event into the terms the ledger will record, or an honest
 * Spanish refusal the assistant can act on.
 */
export function resolveOperationTerms(
  event: ExtractedHoldingEvent,
): OperationTermsResolution {
  const amountMinor = Math.abs(toMinor(event.amount));
  if (amountMinor <= 0) {
    return {
      ok: false,
      error:
        "El importe de la operación que he leído es cero, así que no hay nada que anotar. " +
        "Comprueba el justificante.",
    };
  }

  // A fee in another currency cannot be netted off the amount without inventing a
  // rate (the multidivisa rule, ADR 0065): refuse rather than convert.
  if (event.fees && event.fees.currency.toUpperCase() !== event.currency.toUpperCase()) {
    return {
      ok: false,
      error:
        `La comisión del documento está en ${event.fees.currency} y el importe en ${event.currency}: ` +
        "no convierto divisas por mi cuenta, así que no puedo cuadrar la operación. Anótala en " +
        "las operaciones de esa posición, dentro de Patrimonio.",
    };
  }

  const feesMinor =
    event.fees === undefined ? undefined : Math.abs(toMinor(event.fees.amount));
  const netMinor = amountMinor - (feesMinor ?? 0);
  if (netMinor <= 0) {
    return {
      ok: false,
      error:
        `La comisión (${euros(feesMinor ?? 0, event.currency)}) iguala o supera el importe ` +
        `(${euros(amountMinor, event.currency)}): comprueba las dos cifras, porque una de ellas ` +
        "no puede ser la que creo.",
    };
  }

  const common = {
    amountMinor,
    currency: event.currency,
    executedAt: event.date,
    ...(feesMinor === undefined ? {} : { feesMinor }),
  };

  if (event.units !== undefined && event.units > 0) {
    const units = normalizeDecimal(String(event.units));
    // The price the ledger records is DERIVED so the cash amount is reproduced to the
    // cent — the same division the reconcile's matched rows persist. The printed NAV
    // (rounded to the decimals the fund quotes) is kept as a cross-check below.
    const pricePerUnit = divideUnits(
      minorToDecimal(netMinor),
      units,
      PRICE_READBACK_DECIMALS,
    );
    return {
      ok: true,
      terms: {
        ...common,
        notes: printedPriceNotes(event, units, netMinor, feesMinor),
        pricePerUnit,
        units,
      },
    };
  }

  if (event.pricePerUnit !== undefined && event.pricePerUnit.amount > 0) {
    if (event.pricePerUnit.currency.toUpperCase() !== event.currency.toUpperCase()) {
      return {
        ok: false,
        error:
          `El precio por título está en ${event.pricePerUnit.currency} y el importe en ${event.currency}: ` +
          "no convierto divisas por mi cuenta. Dime las participaciones de la operación, o anótala " +
          "en las operaciones de esa posición, dentro de Patrimonio.",
      };
    }
    const derived = deriveOpeningUnits({
      priceRaw: String(event.pricePerUnit.amount),
      saldoRaw: minorToDecimal(netMinor),
    });
    // Unreachable with a validated positive price and net, but never assume a parse.
    if (!derived.ok) return { ok: false, error: MISSING_QUANTITY };
    return {
      ok: true,
      terms: {
        ...common,
        notes: [
          "El documento no dice las participaciones, así que las derivo del precio que sí " +
            `imprime: ${euros(netMinor, event.currency)} ÷ ${formatDocumentUnitPrice(event.pricePerUnit.amount)} ` +
            `= ${formatUnits(derived.units)} part. Las dos cifras son del documento, pero la ` +
            "cantidad es una división y queda así en el libro: si el justificante trae los " +
            "títulos exactos, dímelos y los anoto tal cual.",
        ],
        pricePerUnit: derived.price,
        units: derived.units,
      },
    };
  }

  return { ok: false, error: MISSING_QUANTITY };
}

/**
 * The cross-check against the price the document PRINTS. Informative and never
 * blocking (the `observedMonthlyPaymentMinor` pattern of `propose_early_repayment`):
 * the figures are the document's, and a confirmation that does not add up is a fact
 * about the confirmation, not a reason to refuse the operation.
 */
function printedPriceNotes(
  event: ExtractedHoldingEvent,
  units: DecimalString,
  netMinor: number,
  feesMinor: number | undefined,
): string[] {
  const printed = event.pricePerUnit;
  if (
    printed === undefined ||
    printed.currency.toUpperCase() !== event.currency.toUpperCase()
  ) {
    return [];
  }
  const computedMinor = multiplyToMinor(units, String(printed.amount));
  const tolerance = reconciliationToleranceMinor(Number(units), printed.amount);
  if (Math.abs(computedMinor - netMinor) <= tolerance) return [];
  return [
    `El documento dice ${euros(event.fees === undefined ? netMinor : netMinor + (feesMinor ?? 0), event.currency)}, ` +
      `pero ${units} × ${printed.amount} ${event.currency}` +
      `${feesMinor === undefined ? "" : ` + ${euros(feesMinor, event.currency)} de comisión`} son ` +
      `${euros(computedMinor + (feesMinor ?? 0), event.currency)}. Anoto las participaciones y el ` +
      "importe tal cual: revisa la cifra si no cuadra.",
  ];
}
