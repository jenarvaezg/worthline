/**
 * The declared savings capacity against what the ledger measures (#1449) — the
 * counterweight to #1416's cut of the plan→FIRE derivation.
 *
 * The rule and its wording live in `savings-coherence`; this family only decides
 * who is asked and dresses the answer as a signal.
 */

import {
  type DataQualityCollector,
  type DataQualityScopeContext,
  signalNaturalKey,
} from "./data-quality-signal";
import type { FireScopeConfig } from "./fire";
import type { InvestmentOperation } from "./investment-types";
import { describeSavingsDivergence, scopeSavingsCoherence } from "./savings-coherence";
import type { Workspace } from "./workspace-types";

/**
 * Machine code for a scope whose declared savings capacity and measured savings
 * cannot both be true (#1449).
 */
export const SAVINGS_DECLARED_VS_MEASURED_CODE = "SAVINGS_DECLARED_VS_MEASURED";

export interface DataQualitySavingsCoherenceInput {
  scope: DataQualityScopeContext;
  workspace: Workspace;
  fireConfigByScopeId: Readonly<Record<string, FireScopeConfig | undefined>>;
  investmentOperationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  asOfDateKey: string;
}

/**
 * The signal states the disagreement and shows all three figures (declared,
 * measured, gap). It deliberately does NOT decide which side is wrong: an
 * optimistic declaration, a stale spending figure, rents declared gross, and
 * savings that never reach an investment all produce the same shape, and only the
 * user knows which one it is. `medium`, like the other figure-shaping config
 * signals: nothing on screen is provably wrong, but the FIRE date is built on a
 * number that has now failed its only available check.
 *
 * Scopes with no FIRE config are silent here — `MISSING_FIRE_CONFIG` already
 * covers them, and there is no declared figure to disagree with.
 */
export const collectSavingsCoherenceSignals: DataQualityCollector<
  DataQualitySavingsCoherenceInput
> = (input) => {
  const config = input.fireConfigByScopeId[input.scope.internalScopeId];
  if (config === undefined) {
    return [];
  }

  const coherence = scopeSavingsCoherence({
    asOfDateKey: input.asOfDateKey,
    config,
    currency: input.workspace.baseCurrency,
    operationsByAssetId: input.investmentOperationsByAssetId,
    ownedHoldingIds: input.ownedAssetIds,
  });

  if (coherence.state !== "diverged") {
    return [];
  }

  return [
    {
      affected: {
        id: input.scope.internalScopeId,
        label: input.scope.scopeLabel,
        object: "scope",
      },
      category: "savings_coherence",
      code: SAVINGS_DECLARED_VS_MEASURED_CODE,
      fixable: true,
      label: describeSavingsDivergence(coherence, input.workspace.baseCurrency),
      naturalKey: signalNaturalKey(
        "savings_coherence",
        SAVINGS_DECLARED_VS_MEASURED_CODE,
        input.scope.internalScopeId,
      ),
      severity: "medium",
    },
  ];
};
