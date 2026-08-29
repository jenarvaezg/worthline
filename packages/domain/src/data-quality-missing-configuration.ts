/**
 * The configuration a scope or a debt needs before its figures can be trusted
 * (PRD #654 S1).
 */

import {
  type DataQualityCollector,
  type DataQualityScopeContext,
  type DataQualitySignal,
  signalNaturalKey,
} from "./data-quality-signal";
import type { FireScopeConfig } from "./fire";
import type { DebtModel, Liability } from "./workspace-types";

export interface DataQualityMissingConfigurationInput {
  scope: DataQualityScopeContext;
  liabilities: readonly Liability[];
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>;
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>;
}

export const collectMissingConfigurationSignals: DataQualityCollector<
  DataQualityMissingConfigurationInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  if (input.fireConfigByScopeId[input.scope.internalScopeId] === undefined) {
    signals.push({
      affected: {
        id: input.scope.internalScopeId,
        label: input.scope.scopeLabel,
        object: "scope",
      },
      category: "missing_configuration",
      code: "MISSING_FIRE_CONFIG",
      fixable: true,
      label: "Este ámbito no tiene configuración FIRE.",
      naturalKey: signalNaturalKey(
        "missing_configuration",
        "MISSING_FIRE_CONFIG",
        input.scope.internalScopeId,
      ),
      severity: "medium",
    });
  }

  for (const liability of input.liabilities) {
    if (!input.ownedAssetIds.has(liability.id) || liability.type !== "mortgage") {
      continue;
    }

    if ((input.debtModelByLiabilityId.get(liability.id) ?? null) === null) {
      signals.push({
        affected: { id: liability.id, label: liability.name, object: "holding" },
        category: "missing_configuration",
        code: "MISSING_DEBT_MODEL",
        fixable: true,
        label: `La hipoteca "${liability.name}" no tiene modelo de deuda.`,
        naturalKey: signalNaturalKey(
          "missing_configuration",
          "MISSING_DEBT_MODEL",
          liability.id,
        ),
        severity: "medium",
      });
    }
  }

  return signals;
};
