/**
 * El cruce de doble conteo (#1675, S4 de #1522): un holding con valor que además tiene
 * una renta declarada ligada a él.
 *
 * Un plan de pensiones puede ser a la vez capital con valor y, convertido en renta, un
 * flujo. Si las dos cosas están declaradas, el mismo dinero cuenta dos veces: como
 * capital que rinde su tasa y como renta. Es el riesgo por el que ADR 0081 rechazó meter
 * la pensión en el motor FIRE.
 *
 * La regla cruza y nombra, nunca borra. Decidir cuál de las dos sobra es del usuario.
 */

import { isHousingAsset } from "./classification";
import type { Income } from "./payouts";
import type { ManualAsset } from "./workspace-types";

/** Lo que el cruce encontró en un holding: él y las rentas ligadas que lo duplican. */
export interface IncomeDoubleCount {
  holdingName: string;
  incomes: readonly Income[];
}

/**
 * El cruce de un holding: null cuando no hay doble conteo que nombrar.
 */
export function incomeDoubleCount(
  asset: ManualAsset,
  incomes: readonly Income[],
  todayISO: string,
): IncomeDoubleCount | null {
  // Un inmueble nunca suma su renta a su valor: la renta SUSTITUYE la tasa del tramo
  // (ADR 0076), y el ladrillo no entra en el capital vendible (ADR 0081). Lo que
  // queda por decir de un alquiler —sin gastos, nominal, terminado— lo dicen ya los
  // avisos de su propia ruta. Una pensión mal tipada como inmueble es un error de
  // instrumento, y se corrige en la ficha (#1512), no aquí.
  if (isHousingAsset(asset)) {
    return null;
  }
  // Sin valor no hay capital que contar dos veces: es la forma honesta de una renta
  // que ya se comió el capital que la genera (una renta vitalicia contratada). El
  // valor guardado es el de la cifra: fuera de la vivienda —que ya salió arriba— y
  // de las deudas, ningún holding se valora por curva.
  if (asset.currentValue.amountMinor <= 0) {
    return null;
  }
  const linked = incomes.filter(
    (income) =>
      income.holdingId === asset.id &&
      // Lo que duplica es la DECLARACIÓN, no la cifra que hoy la lee: cruza la que
      // empieza más adelante, y la que la puerta guardó sin naturaleza o en nominal
      // (una renta vitalicia contratada lo es). Solo calla la terminada: ese dinero
      // ya no llega.
      (income.endISO === null || income.endISO >= todayISO),
  );
  if (linked.length === 0) {
    return null;
  }
  return { holdingName: asset.name, incomes: linked };
}

/**
 * Una sola frase para el inventario, el aviso del home y la ficha: nombra las rentas,
 * el caso en que el mismo dinero cuenta dos veces y la salida del caso legítimo. La
 * decisión es del usuario; la frase solo le da las dos lecturas.
 */
export function describeIncomeDoubleCount(cross: IncomeDoubleCount): string {
  const labels = cross.incomes.map((income) => `«${income.label}»`).join(", ");
  const several = cross.incomes.length > 1;
  const declared = several
    ? `${cross.incomes.length} rentas declaradas ligadas a él`
    : "una renta declarada ligada a él";
  return (
    `«${cross.holdingName}» tiene valor y además ${declared} (${labels}). ` +
    `Si ${several ? "esas rentas salen" : "esa renta sale"} de este capital —una ` +
    "renta vitalicia, un rescate en forma de renta—, el mismo dinero cuenta dos " +
    "veces: como capital y como renta. " +
    `Si ${several ? "son" : "es"} lo que el capital rinde (intereses, un cupón), ` +
    "márcalo como intencional."
  );
}
