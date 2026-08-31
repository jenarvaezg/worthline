import { isRealCalendarDay } from "@worthline/domain";

/**
 * El parser de la fecha de disponibilidad declarada (#1528, ADR 0100).
 *
 * Un campo, `availableFrom`, y una sola regla sobre lo que significa vacío: `null` —
 * «nadie lo ha dicho» — que borra la declaración en vez de escribir una fecha inventada.
 * Es el mismo contrato que el coste de adquisición (#1441): la ausencia es un estado
 * legítimo del dato, no un hueco que haya que rellenar con algo.
 *
 * Lo que se pide es una FECHA y jamás un importe. Un «disponible hoy: 4.979 €» caduca
 * cada año y nadie lo revalida — la avería de #1415, que ADR 0074 prohíbe. La fecha no
 * caduca; lo disponible se deriva en lectura contra el día de quien mira.
 *
 * El día se valida como día real del calendario y no solo por su forma: `2035-02-30`
 * pasa el patrón `YYYY-MM-DD` y `Date` lo desplaza en silencio al 1 de marzo, así que
 * una fecha así se guardaría como un bloqueo que el usuario no ha declarado.
 */
export type AvailableFromResult =
  | { ok: true; availableFrom: string | null }
  | { ok: false; error: string };

/** Dónde se dice, una sola vez, qué es esta fecha y qué NO es. */
export const AVAILABLE_FROM_HELP =
  "El día a partir del cual puedes rescatar este capital. Déjalo vacío si todavía no lo sabes: no adivinamos la fecha a partir de tus movimientos, porque un traspaso desde otra entidad lleva la fecha del trámite y no la de tus aportaciones.";

/** Lo que la ficha dice cuando el holding está a plazo y nadie ha declarado la fecha. */
export const AVAILABLE_FROM_UNDECLARED_NOTE =
  "Sin esta fecha, el reparto de «cuánto puedo gastar agotando el capital» cuenta este dinero como disponible desde el primer año.";

export function parseAvailableFromStrict(formData: FormData): AvailableFromResult {
  const raw = String(formData.get("availableFrom") ?? "").trim();

  if (!raw) {
    return { availableFrom: null, ok: true };
  }

  if (!isRealCalendarDay(raw)) {
    return {
      error: "La fecha de disponibilidad debe ser un día real en formato AAAA-MM-DD.",
      ok: false,
    };
  }

  return { availableFrom: raw, ok: true };
}
