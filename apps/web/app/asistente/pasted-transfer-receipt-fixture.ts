/**
 * The block a person pastes from their bank's «Ejecución de una orden de traspaso de
 * IIC» (#1794, PRD #1793), shared by the suites that read it.
 *
 * What is kept from the incident is the LAYOUT, cell for cell: the same labels in the
 * same order, the same runs of spaces between them, and the same empty «Gastos» cell
 * that prints its currency and no figure. The runs of spaces ARE the table, so they are
 * the part that cannot be paraphrased. Every figure is invented here: the repo is
 * public, and the real paste stays out of git.
 */

export interface PastedTransferReceiptFigures {
  /** What the paper prints under «Operación»: «REEMB.POR TRASPASO I» or its twin. */
  operation: string;
  /** `DD/MM/YYYY`, as the bank prints it. */
  operationDay: string;
  valueDay: string;
  units: string;
  price: string;
  gross: string;
  commission: string;
  net: string;
}

const gap = (width: number): string => " ".repeat(width);

export function pastedTransferReceipt(figures: PastedTransferReceiptFigures): string {
  return (
    `Operación${gap(23)}${figures.operation}${gap(23)}Fecha Operación${gap(9)}Fecha Valor` +
    `${gap(45)}${figures.operationDay}${gap(9)}${figures.valueDay}${gap(53)}` +
    `Número de Participaciones${gap(9)}Valor Liquidativo${gap(9)}Importe Bruto${gap(37)}` +
    `${figures.units}${gap(9)}${figures.price} EUR${gap(9)}${figures.gross} EUR${gap(23)}` +
    `Comisiones${gap(9)}Gastos${gap(9)}Importe Neto${gap(37)}` +
    `${figures.commission} EUR${gap(10)}EUR${gap(9)}${figures.net} EUR`
  );
}

/**
 * The reembolso half of a traspaso, with no commission: 61,60 participaciones out of the
 * origin at 12,0003 € for 739,22 €, operated on 14/08/2026 and valued the day before —
 * the incident's order, which is what makes «Fecha Valor» a trap worth testing.
 */
export const PASTED_REEMBOLSO = pastedTransferReceipt({
  commission: "0.00",
  gross: "739.22",
  net: "739.22",
  operation: "REEMB.POR TRASPASO I",
  operationDay: "14/08/2026",
  price: "12.0003",
  units: "61.60",
  valueDay: "13/08/2026",
});

/** The suscripción half of the same traspaso: the participaciones that ARRIVED. */
export const PASTED_SUSCRIPCION = pastedTransferReceipt({
  commission: "0.00",
  gross: "739.22",
  net: "739.22",
  operation: "SUSCR.POR TRASPASO I",
  operationDay: "14/08/2026",
  price: "14.5010",
  units: "50.98",
  valueDay: "13/08/2026",
});
