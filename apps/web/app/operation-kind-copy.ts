import type { OperationKind } from "@worthline/domain";
import {
  BASE_CURRENCY,
  formatMoneyMinorExact,
  isTransferKind,
  maskMoneyString,
} from "@worthline/domain";

/**
 * How each ledger kind is named on screen (#1393).
 *
 * The two traspaso halves say "Traspaso" plus their direction rather than borrowing
 * the words "Compra" and "Venta": what the user did was move capital between
 * products, and a row labelled "Venta" next to a P/L that did not move would read as
 * a bug in the app rather than as the tax-neutral move it is.
 *
 * One home for the wording, not a ternary at each table: the ficha, the operations
 * editor and the ledger (#825) print the same row.
 */
const OPERATION_KIND_LABELS: Record<OperationKind, string> = {
  buy: "Compra",
  sell: "Venta",
  transfer_in: "Traspaso (entrada)",
  transfer_out: "Traspaso (salida)",
};

export function operationKindLabel(kind: OperationKind): string {
  return OPERATION_KIND_LABELS[kind];
}

/**
 * Who the OTHER half of a traspaso row belongs to (#1481):
 *  - `holding`: the counterpart row exists and its holding has a name.
 *  - `external`: no counterpart row anywhere — the other half lives outside
 *    worthline (MyInvestor's «traer plan desde otra entidad» produces exactly
 *    this half-pair, and one already exists in production data).
 *  - `unresolved`: a counterpart row exists but its holding could not be named
 *    (e.g. it sits in the Papelera). The note then claims nothing about it.
 */
export type TransferRowCounterpart =
  | { kind: "holding"; name: string }
  | { kind: "external" }
  | { kind: "unresolved" };

/**
 * The small annotation under a traspaso row's kind cell (#1481): the pair reads
 * as ONE move with an origin and a destination, never as a loose sale or buy.
 *
 * The inherited cost prints cents-exact (#1315's rule): it is the figure a user
 * checks against the origin's statement, so neither side may round. Privacy mode
 * masks it rather than dropping it — the row keeps its shape.
 *
 * Returns null when there is nothing true to say (a buy/sell, or an unresolved
 * counterpart with no cost to show).
 */
export function transferRowNote(input: {
  kind: OperationKind;
  counterpart: TransferRowCounterpart;
  transferCostMinor?: number | undefined;
  privacyMode: boolean;
}): string | null {
  if (!isTransferKind(input.kind)) return null;

  const segments: string[] = [];

  if (input.counterpart.kind !== "unresolved") {
    const preposition = input.kind === "transfer_out" ? "a" : "desde";
    const name =
      input.counterpart.kind === "holding" ? input.counterpart.name : "otra entidad";
    segments.push(`${preposition} ${name}`);
  }

  if (input.kind === "transfer_in" && input.transferCostMinor !== undefined) {
    const exact = formatMoneyMinorExact({
      amountMinor: input.transferCostMinor,
      currency: BASE_CURRENCY,
    });
    segments.push(`coste heredado ${input.privacyMode ? maskMoneyString(exact) : exact}`);
  }

  return segments.length > 0 ? segments.join(" · ") : null;
}
