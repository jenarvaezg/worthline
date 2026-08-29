/**
 * What the histórico does NOT cover: too few captures, a capture with no holding
 * breakdown, and a debt absent from every capture after its start (#341, #1438).
 */

import {
  type DataQualityCollector,
  type DataQualityScopeContext,
  type DataQualitySignal,
  signalNaturalKey,
} from "./data-quality-collector";
import type { NetWorthSnapshot } from "./snapshot-types";
import type { DebtModel, Liability } from "./workspace-types";

/**
 * Machine code for an amortizable debt that is absent from every historical
 * snapshot after its start (#1438). One per debt, not one per snapshot.
 */
export const DEBT_MISSING_FROM_HISTORY_CODE = "DEBT_MISSING_FROM_HISTORY";

/** Few-snapshots threshold below which history coverage is flagged sparse (#341). */
export const SPARSE_SNAPSHOT_THRESHOLD = 3;

/** One frozen holding row as the history-coverage signal reads it (#1438). */
export interface DataQualitySnapshotHolding {
  dateKey: string;
  holdingId: string;
  kind: "asset" | "liability";
}

export interface DataQualityHistoryCoverageInput {
  scope: DataQualityScopeContext;
  snapshots: readonly NetWorthSnapshot[];
  snapshotIdsWithHoldings: ReadonlySet<string>;
  liabilities: readonly Liability[];
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>;
  /**
   * Amortizable start date keyed by liability id (#1438). Empty = there are no
   * amortizable debts to evaluate, not "skip the signal". Both callers that
   * already read `debtModelByLiabilityId` fill this from the plan / first
   * re-baseline via `amortizableLiabilityStartDate` — the same rule the
   * membership predicate applies.
   */
  amortizableStartByLiabilityId: ReadonlyMap<string, string>;
  /**
   * Frozen holding rows the coverage rules inspect (#1438). Required — not
   * optional — for the same reason `netUnitsByAssetId` is: both consumers feed
   * the same evidence. The home already holds the chart window's `holdingRows`
   * (same honesty as `MISSING_SNAPSHOT_ROWS`: out of window can under-count);
   * the agent-view already reads `readSnapshotHoldings({ scopeId })` in full.
   * `{ dateKey, holdingId, kind }` is enough — the signal never reads values.
   */
  snapshotHoldings: readonly DataQualitySnapshotHolding[];
}

export const collectHistoryCoverageSignals: DataQualityCollector<
  DataQualityHistoryCoverageInput
> = (input) => {
  const signals: DataQualitySignal[] = [];
  const { scope, snapshots } = input;

  if (snapshots.length < SPARSE_SNAPSHOT_THRESHOLD) {
    signals.push({
      affected: {
        id: scope.internalScopeId,
        label: scope.scopeLabel,
        object: "scope",
      },
      category: "history_coverage",
      code: snapshots.length === 0 ? "NO_SNAPSHOTS" : "SPARSE_SNAPSHOTS",
      fixable: false,
      label:
        snapshots.length === 0
          ? "Este ámbito no tiene capturas de patrimonio."
          : "Este ámbito tiene un histórico de capturas escaso.",
      naturalKey: signalNaturalKey(
        "history_coverage",
        snapshots.length === 0 ? "NO_SNAPSHOTS" : "SPARSE_SNAPSHOTS",
        scope.internalScopeId,
      ),
      severity: snapshots.length === 0 ? "medium" : "low",
    });
  }

  for (const snapshot of snapshots) {
    if (input.snapshotIdsWithHoldings.has(snapshot.id)) {
      continue;
    }

    signals.push({
      affected: {
        id: scope.internalScopeId,
        label: scope.scopeLabel,
        object: "scope",
      },
      category: "history_coverage",
      code: "MISSING_SNAPSHOT_ROWS",
      fixable: false,
      label: `La captura del ${snapshot.dateKey} no tiene desglose de holdings.`,
      naturalKey: signalNaturalKey(
        "history_coverage",
        "MISSING_SNAPSHOT_ROWS",
        snapshot.id,
      ),
      observedDate: snapshot.dateKey,
      severity: "low",
    });
  }

  signals.push(...debtMissingFromHistorySignals(input));

  return signals;
};

/**
 * One signal per amortizable debt that is in NONE of the snapshots-with-holdings
 * dated on or after its start (#1438). Silent when that range has no holdings
 * rows at all — that is already `NO_SNAPSHOTS` / `SPARSE_SNAPSHOTS`.
 */
function debtMissingFromHistorySignals(
  input: DataQualityHistoryCoverageInput,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];
  for (const liability of input.liabilities) {
    if (input.debtModelByLiabilityId.get(liability.id) !== "amortizable") continue;
    const startDate = input.amortizableStartByLiabilityId.get(liability.id);
    if (startDate === undefined) continue;

    const inRange = input.snapshotHoldings.filter((row) => row.dateKey >= startDate);
    const datesWithHoldings = new Set(inRange.map((row) => row.dateKey));
    if (datesWithHoldings.size === 0) continue;

    const presentOn = new Set(
      inRange
        .filter((row) => row.kind === "liability" && row.holdingId === liability.id)
        .map((row) => row.dateKey),
    );
    if (presentOn.size > 0) continue;

    signals.push({
      affected: {
        id: liability.id,
        label: liability.name,
        object: "holding",
      },
      category: "history_coverage",
      code: DEBT_MISSING_FROM_HISTORY_CODE,
      fixable: true,
      label: `La deuda "${liability.name}" no aparece en ninguna captura histórica posterior a su inicio (${startDate}).`,
      naturalKey: signalNaturalKey(
        "history_coverage",
        DEBT_MISSING_FROM_HISTORY_CODE,
        liability.id,
      ),
      observedDate: startDate,
      severity: "high",
    });
  }
  return signals;
}
