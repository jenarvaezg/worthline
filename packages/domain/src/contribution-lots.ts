/**
 * Los lotes de aportación: el plan de pensiones que es una escalera y no un bloque
 * (#1676, fase 2 de #1528).
 *
 * La fase 1 le puso UNA fecha al holding, y eso cubre entero el caso «bloqueado hasta
 * los 65». Lo que no cubre es el plan de pensiones de verdad: desde 2025 se pueden
 * rescatar las aportaciones con más de diez años de antigüedad, así que un PP en curso
 * es casi siempre **dos cosas a la vez** — un tramo ya disponible y un tramo todavía
 * no. Con una sola fecha, el partícipe tiene que declarar la del tramo más conservador
 * y se deja fuera lo que ya podría tocar.
 *
 * **Un lote es un hecho declarado**, del mismo rango que un anchor de valoración:
 *
 * - **No toca unidades y no toca coste.** El coste sigue siendo MEDIO, nunca FIFO — el
 *   reparto por lotes de aquí es de **liquidez**, jamás de base fiscal. Cualquier
 *   lectura que intente reconstruir FIFO desde estos lotes inventa descuadres.
 * - **No se persiste ningún importe disponible.** Lo que se guarda es una fecha y un
 *   importe aportado; lo disponible se deriva contra el día que trae el llamador
 *   (ADR 0024: el dominio no lee el reloj), igual que en la fase 1.
 * - **La fecha no se deriva del libro.** Una movilización externa (#1518) lleva la
 *   fecha del trámite, no la de las aportaciones que la generaron. La antigüedad
 *   heredada que #1518 escribe sirve para SUGERIR la fecha en la ficha, y lo que se
 *   guarda es siempre lo que el dueño confirmó.
 *
 * **La regla del tope**, que es donde vive toda la honestidad del módulo: el holding
 * vale hoy lo que vale, y la suma de los lotes casi nunca coincide — un plan sube y
 * baja con el mercado mientras las aportaciones se quedan quietas. Cuando el valor no
 * llega para todo lo declarado, **el bloqueo cobra primero**:
 *
 * 1. `bloqueado = mín(Σ lotes pendientes, valor)`
 * 2. `disponible = mín(Σ lotes vencidos, lo que queda)`
 * 3. el resto es **hueco**: capital a plazo que ningún lote fecha.
 *
 * El orden es la política, no un detalle. Servir primero lo disponible dejaría a un plan
 * con 4.000 € vencidos, 6.000 € pendientes y un valor hundido a 3.000 € leyéndose como
 * 100 % líquido hoy — cumpliendo la letra del tope y prometiendo justo el dinero
 * encerrado que estos módulos existen para no prometer.
 */

import type { DeclaredAvailability } from "./fire-capital-availability";

/** Un lote declarado: cuánto capital, y desde cuándo se puede tocar. */
export interface ContributionLot {
  /** Desde cuándo este tramo se puede rescatar (`YYYY-MM-DD`), tal y como se declaró. */
  availableFrom: string;
  /** El capital que este lote representa, en el importe TOTAL del holding. */
  amountMinor: number;
}

export interface ResolveHoldingLotsInput {
  /** Los lotes del holding. Vacío = no hay escalera declarada. */
  lots: readonly ContributionLot[];
  /**
   * La fecha única de la fase 1 (#1528), cuando la hay. Solo actúa **sin lotes**: una
   * escalera declarada es más precisa que el bloque, y hacerlas convivir daría dos
   * respuestas a la misma pregunta sobre el mismo capital.
   */
  availableFrom: string | undefined;
  /** Lo que el ámbito posee de este holding, bruto de deuda y de reserva. */
  holdingMinor: number;
  /** El día de lectura. `undefined` = el llamador no trajo reloj. */
  todayISO: string | undefined;
}

export interface HoldingAvailability {
  /**
   * Los tramos que siguen bloqueados, listos para que el pool los acumule con los de
   * los demás holdings. Un lote ya vencido NO sale aquí: es capital disponible como
   * cualquier otro, y anunciarlo como tramo lo bloquearía por segunda vez.
   */
  declared: DeclaredAvailability[];
  /**
   * El capital a plazo de este holding que ningún lote ni fecha cubre. No es cero y no
   * es bloqueo: es el hueco que la pantalla nombra en vez de repartirlo en silencio
   * como disponible desde el primer año.
   */
  undeclaredMinor: number;
}

/**
 * Qué parte de un holding a plazo está bloqueada, y hasta cuándo.
 *
 * Sin lotes cae en el comportamiento de la fase 1 tal cual — la fecha única bloquea el
 * holding entero, o sin ella todo es hueco. Con lotes:
 *
 * 1. Los lotes **pendientes** (fecha > hoy) se suman y se topan al valor: eso es el
 *    bloqueo, y cobra antes que nada.
 * 2. Ese bloqueo se reparte entre los lotes pendientes empezando por el que se libera
 *    **más tarde**. Un plan que vale menos que sus aportaciones no dice cuál de ellas
 *    perdió el valor, así que entre los repartos posibles se elige el que libera el
 *    dinero lo más tarde posible — la misma dirección conservadora en la que recorta
 *    `resolveCapitalAvailability`.
 * 3. Lo **vencido** se topa a lo que quede: eso es lo disponible, y no vuelve a
 *    aparecer como tramo (ya se puede tocar, como cualquier otro capital).
 * 4. Lo que sobre es **hueco**: el holding vale más de lo que sus lotes explican y
 *    nadie ha fechado la diferencia.
 *
 * Sin día de lectura no se resuelve nada y el holding entero queda como hueco: es lo
 * único honesto que se puede decir sin reloj, y la pantalla ya sabe nombrarlo.
 */
export function resolveHoldingLots(input: ResolveHoldingLotsInput): HoldingAvailability {
  const { availableFrom, holdingMinor, lots, todayISO } = input;
  const capital = Math.max(0, holdingMinor);

  if (capital === 0) {
    return { declared: [], undeclaredMinor: 0 };
  }

  // Sin lotes manda la fase 1, entera y sin mezclas.
  if (lots.length === 0) {
    return availableFrom === undefined
      ? { declared: [], undeclaredMinor: capital }
      : { declared: [{ amountMinor: capital, availableFrom }], undeclaredMinor: 0 };
  }

  // Sin reloj no se puede decir qué lote venció, y un lote sin resolver no es un
  // bloqueo: es capital cuya fecha esta lectura no ha situado.
  if (todayISO === undefined) {
    return { declared: [], undeclaredMinor: capital };
  }

  const ordered = [...lots]
    .filter((lot) => lot.amountMinor > 0)
    .sort((a, b) => a.availableFrom.localeCompare(b.availableFrom));

  const maturedMinor = ordered
    .filter((lot) => lot.availableFrom <= todayISO)
    .reduce((sum, lot) => sum + lot.amountMinor, 0);
  const pending = ordered.filter((lot) => lot.availableFrom > todayISO);
  const pendingMinor = pending.reduce((sum, lot) => sum + lot.amountMinor, 0);

  // El bloqueo cobra primero: con el valor hundido por debajo de lo declarado, lo que
  // sobrevive es lo que NO se puede tocar, nunca al revés.
  const totalLockedMinor = Math.min(pendingMinor, capital);
  const availableNowMinor = Math.min(maturedMinor, capital - totalLockedMinor);

  let lockedMinor = totalLockedMinor;
  const declared: DeclaredAvailability[] = [];
  // De atrás hacia delante: el bloqueo se agota primero contra los tramos que más
  // tarde se liberan, de modo que lo que sobreviva al tope sea lo más lejano y no lo
  // más próximo. Se recorre invertido y se vuelve a ordenar al salir, porque el
  // consumidor lee el calendario de antes a después.
  for (let index = pending.length - 1; index >= 0 && lockedMinor > 0; index -= 1) {
    const lot = pending[index];
    if (lot === undefined) {
      continue;
    }
    const amountMinor = Math.min(lot.amountMinor, lockedMinor);
    lockedMinor -= amountMinor;
    declared.push({ amountMinor, availableFrom: lot.availableFrom });
  }
  declared.sort((a, b) => a.availableFrom.localeCompare(b.availableFrom));

  // Lo que el holding vale y ningún lote explica: un hueco con nombre, que la pantalla
  // dice en voz alta en vez de repartirlo como disponible desde el primer año.
  return {
    declared,
    undeclaredMinor: capital - totalLockedMinor - availableNowMinor,
  };
}
