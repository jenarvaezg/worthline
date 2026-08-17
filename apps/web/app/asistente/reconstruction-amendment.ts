/**
 * Enmendar una reconstrucción abierta (#1423, ADR 0071) — módulo puro.
 *
 * El caso real: la tarjeta de reconstrucción está en pantalla con 49 saldos y el
 * usuario escribe «los datos son reales hasta la cuota de agosto de 2026, a partir
 * de ahí son estimados». Lo que pide existe en la tarjeta —cada punto tiene su
 * casilla «Excluir» y su importe editable— pero el chat no sabía tocarla, y la
 * única forma de «actualizar la propuesta» era REEMITIR las 49 filas enteras. Ese
 * volcado es exactamente la carga que este pool de modelos deja de producir:
 * `gemini-3.1-flash-lite` narra «he actualizado la propuesta» y no llama a nada.
 *
 * Así que la enmienda no reenvía la serie: son operaciones de dos campos sobre los
 * puntos que YA están persistidos —excluir/reincluir por fecha o por rango, y
 * corregir el importe de un punto—, que es lo que este pool sí produce con
 * fiabilidad.
 *
 * Dos decisiones de forma, ambas para no perder nada:
 *  - La enmienda es una CAPA, no una reescritura: `observations` sigue siendo la
 *    serie cruda del documento (su procedencia) y las enmiendas viven aparte. La
 *    serie efectiva se deriva de las dos con {@link effectiveReconstructionRows}.
 *  - Se enmienda por FECHA, nunca por índice. Un cuadro real repite fecha cuando
 *    ese día pasaron dos cosas (#1422), y un índice sobre una serie que el motor
 *    reordena es una bomba de relojería: excluir «2026-06-01» quita ese día entero.
 */

import type { DatedBalanceObservation, ReconstructPointAmendment } from "@worthline/db";

/** Lo que una enmienda puede hacerle a un punto de la serie. */
export type ReconstructionAmendmentAction = "exclude" | "include" | "set_balance";

/**
 * Una operación de enmienda. `date` apunta a un punto; `from`/`to` (ambos
 * inclusive, ambos opcionales) a un rango — «a partir de agosto de 2026» es un
 * `from` a secas. `balanceMinor` solo lo lee `set_balance`.
 */
export interface ReconstructionAmendmentOperation {
  action: ReconstructionAmendmentAction;
  date?: string;
  from?: string;
  to?: string;
  balanceMinor?: number;
}

export interface AmendedReconstructionSeries {
  ok: true;
  /** La capa de enmiendas resultante, normalizada y ordenada por fecha. */
  amendments: ReconstructPointAmendment[];
  /** Fechas que quedan fuera de la serie aplicable. */
  excludedDates: string[];
  /** Fechas cuyo importe corrigió el usuario a través del chat. */
  correctedDates: string[];
}

export type AmendReconstructionResult =
  | AmendedReconstructionSeries
  | { ok: false; error: string };

/**
 * Una enmienda no es una importación: si hacen falta veinte operaciones para
 * describirla, lo que hay delante es la serie entera otra vez y el sitio de eso es
 * una reconstrucción nueva a partir del documento.
 */
export const MAX_RECONSTRUCTION_AMENDMENT_OPERATIONS = 20;

export const RECONSTRUCTION_AMENDMENT_MESSAGES = {
  balanceNeedsDate:
    "Para corregir un importe hace falta la fecha exacta del punto: un rango de importes sería inventar cifras.",
  emptySelection:
    "Ninguno de los puntos de la serie cae en esa fecha o ese rango, así que no he cambiado nada.",
  emptyTarget: "Dime qué punto o qué rango de fechas enmendar.",
  invalidBalance:
    "El saldo corregido tiene que ser un importe real en céntimos, mayor que 0 €.",
  invalidDate: "Las fechas de una enmienda van en formato AAAA-MM-DD.",
  noOperations: "No me has dicho qué enmendar de la propuesta.",
  nothingLeft:
    "Esa enmienda deja la serie sin ningún saldo que aplicar. Si quieres deshacer la reconstrucción entera, descarta la tarjeta.",
  tooManyOperations: `Una enmienda admite como máximo ${MAX_RECONSTRUCTION_AMENDMENT_OPERATIONS} operaciones; para rehacer la serie entera vuelve a leer el documento.`,
  unknownAction:
    "Las enmiendas de una reconstrucción son 'exclude', 'include' y 'set_balance'.",
  unknownDate: "Esa fecha no está en la serie de saldos de la propuesta.",
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Leer de vuelta la capa persistida. Defensiva porque llega de un JSON del store:
 * una entrada que no dice nada (ni exclusión ni importe) se descarta, y el
 * resultado va ordenado por fecha para que la tarjeta y el confirmar lean lo mismo.
 */
export function normalizeReconstructionAmendments(
  raw: unknown,
): ReconstructPointAmendment[] {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map<string, ReconstructPointAmendment>();
  for (const element of raw) {
    if (!isRecord(element) || typeof element.date !== "string") continue;
    const excluded = element.excluded === true;
    const balanceMinor =
      typeof element.balanceMinor === "number" &&
      Number.isInteger(element.balanceMinor) &&
      element.balanceMinor > 0
        ? element.balanceMinor
        : undefined;
    if (!excluded && balanceMinor === undefined) continue;
    byDate.set(element.date, {
      date: element.date,
      ...(excluded ? { excluded: true } : {}),
      ...(balanceMinor === undefined ? {} : { balanceMinor }),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * La serie que de verdad se proyecta: la observada menos los puntos excluidos, con
 * los importes corregidos en su sitio. Genérica sobre la fila porque la usan el
 * builder (observaciones crudas) y el confirmar (filas ya parseadas, con su tipo).
 */
export function effectiveReconstructionRows<
  Row extends { date: string; balanceMinor: number },
>(rows: readonly Row[], amendments: readonly ReconstructPointAmendment[]): Row[] {
  const byDate = new Map(amendments.map((item) => [item.date, item]));
  const effective: Row[] = [];
  for (const row of rows) {
    const amendment = byDate.get(row.date);
    if (amendment?.excluded) continue;
    effective.push(
      amendment?.balanceMinor === undefined
        ? row
        : { ...row, balanceMinor: amendment.balanceMinor },
    );
  }
  return effective;
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Las fechas observadas que una operación selecciona, sin repetir. */
function selectedDates(
  observedDates: readonly string[],
  operation: ReconstructionAmendmentOperation,
): string[] {
  if (operation.date !== undefined) {
    return observedDates.filter((date) => date === operation.date);
  }
  return observedDates.filter(
    (date) =>
      (operation.from === undefined || date >= operation.from) &&
      (operation.to === undefined || date <= operation.to),
  );
}

function invalidDates(operation: ReconstructionAmendmentOperation): boolean {
  return (["date", "from", "to"] as const).some(
    (key) => operation[key] !== undefined && !isValidDate(operation[key]),
  );
}

/**
 * Aplicar una tanda de operaciones sobre la capa de enmiendas vigente.
 *
 * Todo o nada, y en voz alta: cualquier operación que no toque un punto real
 * devuelve un error en vez de un silencio. El silencio es justo el fallo que esta
 * issue arregla —el modelo diciendo «he actualizado la propuesta» sin haberlo
 * hecho—, así que una enmienda que no cambia nada no puede parecer que sí.
 */
export function amendedReconstructionSeries(
  observations: readonly DatedBalanceObservation[],
  amendments: readonly ReconstructPointAmendment[],
  operations: readonly ReconstructionAmendmentOperation[],
): AmendReconstructionResult {
  // `required` en un `jsonSchema()` no se valida en tiempo de ejecución, así que lo
  // que llega aquí es la salida cruda de un modelo: sin este guardia, un
  // `operations: {}` sería un for-of sobre algo no iterable, es decir una excepción
  // en medio del stream en vez de una frase que el usuario pueda leer.
  if (!Array.isArray(operations) || operations.length === 0) {
    return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.noOperations, ok: false };
  }
  if (operations.length > MAX_RECONSTRUCTION_AMENDMENT_OPERATIONS) {
    return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.tooManyOperations, ok: false };
  }

  const observedDates = observations.map((row) => row.date);
  const next = new Map(
    normalizeReconstructionAmendments(amendments).map((item) => [item.date, item]),
  );
  // `Array.isArray` estrecha a `any[]` y se llevaría por delante el tipo de cada
  // operación; el alias lo recupera sin volver a confiar en la forma.
  const requested: readonly ReconstructionAmendmentOperation[] = operations;

  for (const operation of requested) {
    if (!isRecord(operation)) {
      return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.unknownAction, ok: false };
    }
    if (
      operation.action !== "exclude" &&
      operation.action !== "include" &&
      operation.action !== "set_balance"
    ) {
      return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.unknownAction, ok: false };
    }
    if (invalidDates(operation)) {
      return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.invalidDate, ok: false };
    }

    if (operation.action === "set_balance") {
      if (operation.date === undefined) {
        return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.balanceNeedsDate, ok: false };
      }
      const { balanceMinor } = operation;
      if (
        typeof balanceMinor !== "number" ||
        !Number.isInteger(balanceMinor) ||
        balanceMinor <= 0
      ) {
        return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.invalidBalance, ok: false };
      }
      if (!observedDates.includes(operation.date)) {
        return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.unknownDate, ok: false };
      }
      // Corregir un punto es quererlo: su exclusión previa —del asistente, no del
      // motor— deja de tener sentido, y así «ese saldo era 145.500» no obliga a dos
      // llamadas para que el punto vuelva a contar.
      next.set(operation.date, { balanceMinor, date: operation.date });
      continue;
    }

    if (
      operation.date === undefined &&
      operation.from === undefined &&
      operation.to === undefined
    ) {
      return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.emptyTarget, ok: false };
    }
    const selected = selectedDates(observedDates, operation);
    if (selected.length === 0) {
      return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.emptySelection, ok: false };
    }
    for (const date of selected) {
      const current = next.get(date);
      if (operation.action === "exclude") {
        next.set(date, { ...current, date, excluded: true });
        continue;
      }
      // Reincluir levanta la exclusión y CONSERVA el importe corregido, si lo había:
      // volver a meter un punto no es olvidar lo que el usuario dijo que valía.
      const corrected = current?.balanceMinor;
      if (corrected === undefined) next.delete(date);
      else next.set(date, { balanceMinor: corrected, date });
    }
  }

  const result = normalizeReconstructionAmendments([...next.values()]);
  if (effectiveReconstructionRows(observations, result).length === 0) {
    return { error: RECONSTRUCTION_AMENDMENT_MESSAGES.nothingLeft, ok: false };
  }
  return {
    amendments: result,
    correctedDates: result
      .filter((item) => !item.excluded && item.balanceMinor !== undefined)
      .map((item) => item.date),
    excludedDates: result.filter((item) => item.excluded).map((item) => item.date),
    ok: true,
  };
}
