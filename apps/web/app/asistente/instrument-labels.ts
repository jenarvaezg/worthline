/**
 * es-ES instrument labels for assistant proposal cards (#1105/#1106). Shared by
 * the alta (S2) and the baja/restauración (S3) surfaces so the "name · label ·
 * detail" row reads the same wording everywhere.
 */

import type { Instrument } from "@worthline/domain";

export const INSTRUMENT_LABEL: Partial<Record<Instrument, string>> = {
  credit_card: "Tarjeta de crédito",
  crypto: "Cripto",
  current_account: "Cuenta corriente",
  etf: "ETF",
  fund: "Fondo",
  index: "Índice",
  loan: "Préstamo",
  mortgage: "Hipoteca",
  other: "Otro bien",
  pension_plan: "Plan de pensiones",
  precious_metal: "Metal precioso",
  property: "Inmueble",
  stock: "Acción",
  term_deposit: "Depósito a plazo",
  vehicle: "Vehículo",
};

/**
 * The es-ES label for an instrument (or its raw value when unmapped), with a
 * caller-chosen fallback for a holding that carries no instrument at all (e.g. a
 * bare liability). Never throws — presentation only.
 */
export function instrumentLabel(
  instrument: string | null | undefined,
  fallback = "Holding",
): string {
  if (!instrument) return fallback;
  return INSTRUMENT_LABEL[instrument as Instrument] ?? instrument;
}
