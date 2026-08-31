/**
 * es-ES labels for the instrument vocabulary (#154).
 *
 * One map, so the grouping headers on the board, the ficha's correction picker
 * (#1512) and anything else that has to name an instrument read the same wording.
 * Presentation only — no rule of the catalog lives here.
 */

import type { Instrument } from "./instrument-catalog";

export const INSTRUMENT_LABELS_ES: Record<Instrument, string> = {
  coin_collection: "Colección de monedas",
  credit_card: "Tarjeta de crédito",
  crypto: "Cripto",
  current_account: "Cuenta corriente",
  etf: "ETF",
  fund: "Fondo",
  index: "Índice",
  loan: "Préstamo",
  mortgage: "Hipoteca",
  other: "Otro",
  pension_plan: "Plan de pensiones",
  precious_metal: "Metal precioso",
  property: "Inmueble",
  stock: "Acción",
  term_deposit: "Depósito a plazo",
  vehicle: "Vehículo",
};

/** The es-ES label for an instrument. Total over the catalog — never throws. */
export function instrumentLabelEs(instrument: Instrument): string {
  return INSTRUMENT_LABELS_ES[instrument];
}
