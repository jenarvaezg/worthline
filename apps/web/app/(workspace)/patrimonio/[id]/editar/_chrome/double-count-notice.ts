/**
 * Lo que los Cobros de la ficha dicen del cruce de doble conteo (#1675): la frase del
 * motor, o nada si no hay cruce o el usuario ya dijo que es intencional.
 *
 * La regla es la del motor (`incomeDoubleCount`) y el reconocimiento se lee con su
 * mismo pliegue (`overriddenSignalKeys`): la ficha y el aviso del home no pueden
 * discrepar sobre si un holding sigue preguntando. Reconocido, sigue en el inventario
 * del asistente, etiquetado (ADR 0004); aquí deja de preguntar, como un aviso.
 */

import {
  describeIncomeDoubleCount,
  INCOME_DOUBLE_COUNT_CODE,
  type Income,
  incomeDoubleCount,
  type ManualAsset,
  overriddenSignalKeys,
  type WarningOverride,
} from "@worthline/domain";

export function doubleCountNotice(input: {
  asset: ManualAsset;
  /** The incomes linked to this holding, as the Cobros panel read them. */
  incomes: readonly Income[];
  overrides: readonly WarningOverride[];
  todayISO: string;
}): string | null {
  const { asset, incomes, overrides, todayISO } = input;
  const cross = incomeDoubleCount(asset, incomes, todayISO);
  if (cross === null) {
    return null;
  }
  const acknowledged = overriddenSignalKeys(overrides).has(
    `${INCOME_DOUBLE_COUNT_CODE}:${asset.id}`,
  );
  return acknowledged ? null : describeIncomeDoubleCount(cross);
}
