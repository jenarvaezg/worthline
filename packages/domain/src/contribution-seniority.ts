/**
 * La antigüedad que el LIBRO sí conoce (#1687).
 *
 * #1676 deja declarar la escalera de un plan de pensiones lote a lote, y #1528 sugiere
 * la fecha cuando el capital trae antigüedad heredada. Lo que ninguno de los dos hace
 * es mirar el ledger del propio holding: quien lleva años aportando **dentro de
 * worthline** tiene todas las fechas escritas y aun así teclea cada lote a mano.
 *
 * Este módulo lee ese ledger y dice, por cada entrada de capital, **desde cuándo cuenta
 * su antigüedad** y **cuánto capital entró**. Nada más:
 *
 * - **No sabe qué es la ventana de los diez años.** Convertir «desde cuándo cuenta» en
 *   «desde cuándo se puede tocar» es una regla legal, y vive en la capa de intake
 *   (ADR 0100, enmienda #1676). Aquí sólo se leen hechos del libro.
 * - **No propone nada.** Devuelve materia prima; quien la convierte en lotes es la
 *   pantalla, y lo que se guarda es siempre lo que el dueño confirmó.
 *
 * **Qué fila sirve y cuál no**, que es toda la sustancia:
 *
 * | Fila | Antigüedad |
 * |---|---|
 * | `buy` real | `executedAt` — la aportación se hizo ese día |
 * | `transfer_in` con antigüedad declarada (#1518) | la declarada, nunca `executedAt` |
 * | `transfer_in` sin declararla | **ninguna**: la movilización trae capital cuya edad vive en otra entidad |
 * | `source: "opening"` | **ninguna**: una apertura fabrica fecha y coste (#1490, ADR 0048) |
 *
 * Las que no sirven no se descartan en silencio: salen nombradas, porque un holding que
 * propone la mitad de su escalera sin decir qué mitad falta es peor que uno que no
 * propone nada.
 *
 * **Las salidas no restan de ningún tramo.** Un `sell` o un `transfer_out` reducen el
 * plan, pero el libro no dice de qué aportación salieron, y repartirlas por FIFO
 * inventaría descuadres — el coste aquí es medio, nunca FIFO, y este reparto es de
 * liquidez. El recorte lo hace el tope al valor del holding, que `resolveHoldingLots`
 * ya aplica: la suma de lo propuesto nunca puede exceder lo que el plan vale hoy.
 */

import { multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";

/** Una entrada de capital cuya antigüedad el libro sí conoce. */
export interface LedgerSeniority {
  /** Desde cuándo cuenta la antigüedad de este capital (`YYYY-MM-DD`). */
  seniorityAt: string;
  /** Lo que entró, en unidades menores. Siempre > 0. */
  amountMinor: number;
}

/** Por qué una fila del libro no puede decir su antigüedad. */
export type SeniorityGapReason = "transfer_without_seniority" | "opening" | "unpriced";

export interface SeniorityGap {
  reason: SeniorityGapReason;
  /** El capital que esa fila metió y que ningún tramo propuesto puede explicar. */
  amountMinor: number;
}

export interface LedgerSeniorityReport {
  /** Las entradas utilizables, de antes a después. */
  entries: LedgerSeniority[];
  /** Lo que el libro NO puede fechar, por razón — para nombrarlo en vez de callarlo. */
  gaps: SeniorityGap[];
}

/**
 * Leer el ledger de un holding y separar lo que sabe fechar de lo que no.
 *
 * Puro y sin reloj (ADR 0024): quién compara estas fechas con hoy es cosa de quien
 * mide. Y sin opinión sobre la ventana normativa, que no es un hecho del libro.
 */
export function readLedgerSeniority(
  operations: readonly InvestmentOperation[],
): LedgerSeniorityReport {
  const entries: LedgerSeniority[] = [];
  const gapsByReason = new Map<SeniorityGapReason, number>();

  const addGap = (reason: SeniorityGapReason, amountMinor: number): void => {
    if (amountMinor > 0) {
      gapsByReason.set(reason, (gapsByReason.get(reason) ?? 0) + amountMinor);
    }
  };

  for (const operation of operations) {
    // Una salida no resta de ningún tramo: el libro no dice de qué aportación salió.
    if (operation.kind === "sell" || operation.kind === "transfer_out") {
      continue;
    }

    const amountMinor =
      operation.kind === "transfer_in"
        ? // Lo que la movilización trajo es su coste heredado, no units × precio: ese
          // producto reiniciaría la plusvalía a cero y trataría el traspaso como una
          // compra nueva que nunca hubo (#1393).
          (operation.transferCostMinor ??
          multiplyToMinor(operation.units, operation.pricePerUnit))
        : multiplyToMinor(operation.units, operation.pricePerUnit);

    if (amountMinor <= 0) {
      addGap("unpriced", 0);
      continue;
    }

    // Una apertura no es una aportación: su fecha y su precio los fabricó el alta para
    // poder abrir la posición, así que fecharla sería inventar antigüedad (#1490).
    if (operation.source === "opening") {
      addGap("opening", amountMinor);
      continue;
    }

    if (operation.kind === "transfer_in") {
      if (operation.transferSeniorityAt) {
        entries.push({ amountMinor, seniorityAt: operation.transferSeniorityAt });
      } else {
        addGap("transfer_without_seniority", amountMinor);
      }
      continue;
    }

    entries.push({ amountMinor, seniorityAt: operation.executedAt });
  }

  entries.sort((a, b) => a.seniorityAt.localeCompare(b.seniorityAt));

  return {
    entries,
    gaps: [...gapsByReason.entries()].map(([reason, amountMinor]) => ({
      amountMinor,
      reason,
    })),
  };
}
