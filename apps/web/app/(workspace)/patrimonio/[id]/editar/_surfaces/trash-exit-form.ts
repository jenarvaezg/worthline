import type { StrictParseResult } from "@web/intake";
import { parseMoneyMinor } from "@web/intake-primitives";
import type { CurrencyCode, DecimalString, HoldingTrashRefusal } from "@worthline/domain";
import {
  compareUnits,
  divideUnits,
  formatUnits,
  minorToDecimal,
  PRICE_READBACK_DECIMALS,
} from "@worthline/domain";

/**
 * The Papelera door's «Lo vendí» exit (#1549) — its pure seam.
 *
 * The exit exists because the correct repair for a holding with money inside is
 * almost always a sale that was never recorded ("ya no lo tengo, lo borro"). Making
 * the owner leave for the operations ledger, look up his participaciones and divide
 * out a VL is exactly the friction that produced the Groupama silence, so the door
 * asks for the two figures a bank confirmation actually states: the DATE and the
 * IMPORTE received.
 *
 * The rest is derived, and derived HERE rather than typed: the sale closes the
 * position, so its participaciones are the ones the ledger folds to, and the VL is
 * the importe over them — the same derivation `planTransfer` makes for a declared
 * leg (`deriveLegPrice`), at the same readback precision. Nothing about this exit
 * lets a figure into the book that the ledger and the paper do not already agree
 * on.
 *
 * What it deliberately does NOT do: write. The command it returns goes through
 * `createInvestmentOperationSafe` and the ordinary operation gate, so this sale
 * ripples its snapshots exactly like a sale typed on the ficha — one engine (#1438).
 */

/** The form id a refused exit comes back under, so the door renders its own band. */
export const TRASH_FORM_ID = "trash";

/** The fields a rejected submit round-trips, so nothing typed is lost (#1329). */
export const TRASH_EXIT_FORM_FIELDS = ["exit", "soldAt", "soldAmount"] as const;

/** The closing sale, resolved into the three figures the operation row needs. */
export interface TrashSaleDraft {
  executedAt: string;
  /** Every participación the ledger still holds — the sale CLOSES the position. */
  units: DecimalString;
  pricePerUnit: DecimalString;
  /** The importe received, echoed back for the message that confirms it. */
  amountMinor: number;
  currency: CurrencyCode;
}

export interface TrashSaleContext {
  /** Net units the ledger folds to today. */
  netUnits: DecimalString;
  /** The ledger's currency — the sale is an apunte in it, like any other. */
  currency: CurrencyCode;
  /** Today, for the date the form defaults to. */
  today: string;
}

export function parseTrashSaleForm(
  values: { soldAt: string; soldAmount: string },
  { currency, netUnits, today }: TrashSaleContext,
): StrictParseResult<TrashSaleDraft> {
  if (compareUnits(netUnits, "0") <= 0) {
    return {
      error: "Esta posición ya está a cero: elimínala sin registrar ninguna venta.",
      ok: false,
    };
  }

  const executedAt = values.soldAt.trim() || today;
  const amountMinor = parseMoneyMinor(values.soldAmount.trim());

  if (amountMinor === null || amountMinor <= 0) {
    return { error: "Escribe el importe que recibiste por la venta.", ok: false };
  }

  const pricePerUnit = divideUnits(
    minorToDecimal(amountMinor),
    netUnits,
    PRICE_READBACK_DECIMALS,
  );

  // An importe of cents spread over millions of participaciones rounds the VL away,
  // and a row priced at 0 would value the position at nothing. Refused, not stored —
  // the same call `deriveLegPrice` makes on the traspaso's legs.
  if (compareUnits(pricePerUnit, "0") <= 0) {
    return {
      error: "Ese importe es demasiado pequeño para las participaciones que quedan.",
      ok: false,
    };
  }

  return {
    command: { amountMinor, currency, executedAt, pricePerUnit, units: netUnits },
    ok: true,
  };
}

/**
 * What the door says when it refuses (#1549) — in the owner's words, naming the
 * three exits rather than the rule they failed. It lives beside the parser instead
 * of in the action because a `"use server"` module may export nothing but actions.
 */
export function trashRefusalMessage(refusal: HoldingTrashRefusal): string {
  return refusal.reason === "portfolio_cash"
    ? `Ese efectivo es la caja de la cartera «${refusal.portfolioName}», no una posición tuya. ` +
        "Si quieres quitarlo, borra la cartera: la casilla quedará como una cuenta normal."
    : `Ese activo conserva ${formatUnits(refusal.netUnits)} participaciones. ` +
        "Dinos a dónde fue el dinero — lo vendiste, lo traspasaste, o fue un error de registro — " +
        "antes de mandarlo a la Papelera.";
}
