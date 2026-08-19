import type { OperationKind } from "@worthline/domain";

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
