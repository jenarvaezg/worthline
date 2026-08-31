import { isRealCalendarDay } from "@worthline/domain";
import { parseMoneyMinorField } from "./shared";

/**
 * El intake de los lotes de aportación (#1676, fase 2 de #1528).
 *
 * Un lote se declara con dos cosas y nada más: **desde cuándo se puede tocar** y
 * **cuánto**. Nunca «lo disponible hoy», que caduca cada año y nadie revalida (ADR
 * 0074, la avería de #1415): lo disponible se deriva en lectura contra el día de quien
 * mira, y la escalera declarada no se mueve sola.
 *
 * **La ventana normativa vive aquí y solo aquí.** Desde 2025 las aportaciones a un plan
 * de pensiones con más de diez años de antigüedad son rescatables, y de ahí sale la
 * fecha que la ficha SUGIERE cuando el capital entró por movilización y trae antigüedad
 * heredada (#1518). Es una ayuda de la interfaz, jamás una verdad del motor: lo que se
 * guarda es lo que el dueño confirmó, y el cálculo de FIRE no sabe qué es un año
 * fiscal ni cuántos hacen falta. Si la regla cambia, cambia una constante de esta capa
 * y ninguna cifra ya declarada se mueve.
 */

/**
 * Los años de antigüedad tras los que una aportación a un plan de pensiones se puede
 * rescatar. Una regla LEGAL, no un hecho del libro, y por eso no cruza al dominio.
 */
export const PENSION_LIQUIDITY_WINDOW_YEARS = 10;

export type ContributionLotResult =
  | { ok: true; availableFrom: string; amountMinor: number }
  | { ok: false; error: string };

/** Qué se está pidiendo, dicho una sola vez. */
export const CONTRIBUTION_LOT_HELP =
  "Cada lote es un tramo de tus aportaciones con su propia fecha de rescate. Sácalos del extracto de tu gestora: es el único sitio donde está la antigüedad real, porque un traspaso desde otra entidad conserva la antigüedad de las aportaciones que lo generaron.";

/** Lo que la ficha dice cuando el holding tiene lotes pero no cubren su valor. */
export const CONTRIBUTION_LOT_PARTIAL_NOTE =
  "Lo que tus lotes no cubren se cuenta como capital a plazo sin fecha, no como disponible: el reparto no lo promete antes de tiempo.";

/**
 * La fecha que la ficha propone para un lote, a partir de la antigüedad heredada que
 * #1518 declaró: esa antigüedad más la ventana normativa.
 *
 * Devuelve `null` sin antigüedad declarada — y ese es el caso por defecto. Nunca cae a
 * la fecha de la fila: `executed_at` es el día del trámite de la movilización, y
 * leerlo como antigüedad diría «bloqueado hasta 2035» sobre dinero rescatable hoy, que
 * es la invención que #1518 y #1528 vinieron a cerrar.
 */
export function suggestedLotAvailableFrom(seniorityAt: string | null): string | null {
  if (seniorityAt === null || !isRealCalendarDay(seniorityAt)) {
    return null;
  }

  const year = Number(seniorityAt.slice(0, 4)) + PENSION_LIQUIDITY_WINDOW_YEARS;
  const monthDay = seniorityAt.slice(4);
  const candidate = `${year}${monthDay}`;

  // Un 29 de febrero + 10 años cae en un año que no lo tiene. Se mueve al 1 de marzo,
  // que es el primer día en que el tramo es rescatable con seguridad — y hacia
  // adelante, nunca hacia atrás: adelantarlo prometería liquidez un día antes de que
  // exista.
  return isRealCalendarDay(candidate) ? candidate : `${year}-03-01`;
}

export function parseContributionLot(formData: FormData): ContributionLotResult {
  const availableFrom = String(formData.get("lotAvailableFrom") ?? "").trim();

  if (!availableFrom) {
    return { error: "Dinos desde cuándo se puede rescatar este lote.", ok: false };
  }

  if (!isRealCalendarDay(availableFrom)) {
    return {
      error: "La fecha del lote debe ser un día real en formato AAAA-MM-DD.",
      ok: false,
    };
  }

  const amountMinor = parseMoneyMinorField(formData, "lotAmount");

  if (amountMinor === null) {
    return { error: "Dinos cuánto capital hay en este lote.", ok: false };
  }

  // Un lote de cero no es una declaración y uno negativo no es nada. El seam del store
  // lo rechaza igual; decirlo aquí es lo que convierte el rechazo en una frase.
  if (amountMinor <= 0) {
    return { error: "El importe de un lote tiene que ser mayor que cero.", ok: false };
  }

  return { amountMinor, availableFrom, ok: true };
}
