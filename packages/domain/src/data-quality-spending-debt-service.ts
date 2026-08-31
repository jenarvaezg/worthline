/**
 * El gasto declarado contra la cuota que la app ya conoce (#1520) — el testigo del
 * servicio de deuda, dressed as a signal.
 *
 * La regla y las palabras viven en `spending-debt-service`; esta familia solo decide a
 * quién se le pregunta. Hermana de `data-quality-savings-coherence`: las dos cruzan una
 * declaración del usuario contra la única medida que la app puede sacar sola.
 */

import {
  type DataQualityCollector,
  type DataQualityScopeContext,
  signalNaturalKey,
} from "./data-quality-collector";
import type { FireScopeConfig } from "./fire";
import {
  describeSpendingDebtServiceGap,
  scopeSpendingDebtService,
} from "./spending-debt-service";
import type { Liability, Workspace } from "./workspace-types";

/**
 * Máquina para un ámbito cuyo gasto declarado y cuyas cuotas vigentes no se pueden
 * leer juntas: o se contradicen, o falta la declaración que decide qué significan
 * las dos cifras de flujo de la pantalla (#1520).
 */
export const SPENDING_VS_DEBT_SERVICE_CODE = "SPENDING_VS_DEBT_SERVICE";

export interface DataQualitySpendingDebtServiceInput {
  scope: DataQualityScopeContext;
  workspace: Workspace;
  liabilities: readonly Liability[];
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>;
  /**
   * La cuota vigente de cada deuda al 100 % (`debtServiceAtDate`), en unidades
   * menores. La deriva el llamador porque el hecho vive en tres tablas —el plan, sus
   * revisiones y sus amortizaciones— y el motor de señales no hace I/O; una deuda
   * ausente no tiene cuota que worthline conozca.
   */
  debtServiceByLiabilityId: ReadonlyMap<string, number>;
}

/**
 * Dos casos, dos severidades, y ninguno mueve una cifra:
 *
 * - **`impossible`** (`high`): declara que su gasto incluye el servicio de deuda y la
 *   cuota no cabe dentro de ese gasto. Aquí una de las dos cifras que responden «¿de
 *   cuánto puedo vivir?» es demostrablemente falsa, no dudosa.
 * - **`undeclared`** (`medium`): hay una cuota que cambia la lectura y nadie ha dicho
 *   si el gasto la incluye. Como las demás señales que dan forma a una cifra: nada en
 *   pantalla está mal, pero la cobertura del gasto admite dos lecturas y la app no
 *   sabe cuál está imprimiendo.
 *
 * Un ámbito sin config FIRE calla — `MISSING_FIRE_CONFIG` ya lo cubre y no hay gasto
 * declarado con el que discrepar.
 */
export const collectSpendingDebtServiceSignals: DataQualityCollector<
  DataQualitySpendingDebtServiceInput
> = (input) => {
  const config = input.fireConfigByScopeId[input.scope.internalScopeId];
  if (config === undefined) {
    return [];
  }

  const coherence = scopeSpendingDebtService({
    config,
    currency: input.workspace.baseCurrency,
    debtServiceByLiabilityId: input.debtServiceByLiabilityId,
    liabilities: input.liabilities,
    // Los miembros que el facade ya resolvió: dos familias no pueden discrepar sobre
    // quién es el ámbito.
    scopeMemberIds: input.scopeMemberIds,
  });

  if (coherence.state !== "impossible" && coherence.state !== "undeclared") {
    return [];
  }

  return [
    {
      affected: {
        id: input.scope.internalScopeId,
        label: input.scope.scopeLabel,
        object: "scope",
      },
      category: "spending_coherence",
      code: SPENDING_VS_DEBT_SERVICE_CODE,
      fixable: true,
      label:
        describeSpendingDebtServiceGap(coherence, input.workspace.baseCurrency) ?? "",
      naturalKey: signalNaturalKey(
        "spending_coherence",
        SPENDING_VS_DEBT_SERVICE_CODE,
        input.scope.internalScopeId,
      ),
      severity: coherence.state === "impossible" ? "high" : "medium",
    },
  ];
};
