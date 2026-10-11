/**
 * El cruce de doble conteo (#1675), vestido de señal.
 *
 * La regla y las palabras viven en `income-double-count`; esta familia solo decide a
 * qué holdings del ámbito se les pregunta. Hermana de `data-quality-savings-coherence`
 * y `data-quality-spending-debt-service`: las tres cruzan una declaración del usuario
 * contra otra, y ninguna mueve una cifra.
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  signalLabelWithOverride,
  signalNaturalKey,
} from "./data-quality-collector";
import { describeIncomeDoubleCount, incomeDoubleCount } from "./income-double-count";
import type { Income } from "./payouts";
import type { ManualAsset } from "./workspace-types";

/** Máquina para un holding con valor y una renta ligada que puede duplicarlo. */
export const INCOME_DOUBLE_COUNT_CODE = "INCOME_DOUBLE_COUNT";

export interface DataQualityIncomeDoubleCountInput {
  asOfDateKey: string;
  assets: readonly ManualAsset[];
  /** Todas las rentas declaradas, con o sin activo (ADR 0108). */
  incomes: readonly Income[];
}

/**
 * Una señal por holding, nombrando todas sus rentas ligadas (#1356: una por cosa que
 * el usuario accionaría, nunca una por fila).
 *
 * `medium`: nada en pantalla es demostrablemente falso. El mismo par —valor y renta
 * ligada— es un doble conteo si la renta sale del capital y es legítimo si es lo que
 * el capital rinde, y la app no tiene con qué distinguirlos. Por eso es reconocible
 * (ADR 0004): un depósito con intereses fijos declarados se marca una vez como
 * intencional y deja de preguntar.
 *
 * El inmueble calla por construcción (ADR 0076): su renta sustituye la tasa del
 * tramo, nunca se suma.
 */
export const collectIncomeDoubleCountSignals: DataQualityCollector<
  DataQualityIncomeDoubleCountInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const asset of input.assets) {
    if (!input.ownedAssetIds.has(asset.id)) {
      continue;
    }
    const cross = incomeDoubleCount(asset, input.incomes, input.asOfDateKey);
    if (cross === null) {
      continue;
    }
    signals.push({
      affected: { id: asset.id, label: asset.name, object: "holding" },
      category: "income_coherence",
      code: INCOME_DOUBLE_COUNT_CODE,
      fixable: true,
      label: signalLabelWithOverride(
        describeIncomeDoubleCount(cross),
        INCOME_DOUBLE_COUNT_CODE,
        asset.id,
        input.overriddenKeys,
        true,
      ),
      naturalKey: signalNaturalKey(
        "income_coherence",
        INCOME_DOUBLE_COUNT_CODE,
        asset.id,
      ),
      severity: "medium",
    });
  }

  return signals;
};
