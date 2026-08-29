/**
 * The domain warnings, as data-quality signals (PRD #654 S1).
 *
 * This family owns no rule of its own: the inventory is `collectWarnings`, and
 * here it is only scoped, labelled and given a natural key.
 */

import {
  type DataQualityCollector,
  type DataQualitySeverity,
  type DataQualitySignal,
  signalLabelWithOverride,
  signalNaturalKey,
} from "./data-quality-signal";
import type { DecimalString } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { collectWarnings, type DomainWarning, type WarningSeverity } from "./warnings";
import type { ManualAsset } from "./workspace-types";

export interface DataQualityWarningInput {
  assets: readonly ManualAsset[];
  /**
   * Net units still held per investment holding (`netUnitsByAsset`), for holdings
   * with at least one recorded operation. Required — not optional — so both
   * consumers of this engine (the home hero and the agent view's
   * `get_data_quality`) are forced to feed the SAME closed-position filter
   * instead of each growing its own (#1348).
   */
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>;
  /**
   * The investment ledger keyed by holding id. Required, not optional, for the
   * same reason `netUnitsByAssetId` is: both consumers already hold this map, and
   * a signal only one of them feeds is a signal the human and the agent disagree
   * about.
   */
  investmentOperationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
}

export const collectWarningSignals: DataQualityCollector<DataQualityWarningInput> = (
  input,
) => {
  // Overrides are NOT passed to `collectWarnings`: an acknowledged warning stays
  // in the inventory and gets labelled instead of dropped. The closed-position
  // filter is different — a sold-out position has no pending task at all (#1348).
  return collectWarnings([...input.assets], [], {
    netUnitsByAssetId: input.netUnitsByAssetId,
    operationsByAssetId: input.investmentOperationsByAssetId,
  })
    .filter((warning) => input.ownedAssetIds.has(warning.entityId))
    .map((warning) => warningToSignal(warning, input.overriddenKeys, input.assets));
};

function warningToSignal(
  warning: DomainWarning,
  overriddenKeys: ReadonlySet<string>,
  assets: readonly ManualAsset[],
): DataQualitySignal {
  const label = signalLabelWithOverride(
    warning.message,
    warning.code,
    warning.entityId,
    overriddenKeys,
    warning.severity === "overrideable",
  );

  return {
    affected: {
      id: warning.entityId,
      label: assetLabel(assets, warning.entityId),
      object: "holding",
    },
    category: "warning",
    code: warning.code,
    fixable: true,
    label,
    naturalKey: signalNaturalKey("warning", warning.code, warning.entityId),
    originalWarningType: warning.code,
    severity: warningSeverity(warning.severity),
  };
}

function warningSeverity(severity: WarningSeverity): DataQualitySeverity {
  return severity === "blocking" ? "high" : "medium";
}

function assetLabel(assets: readonly ManualAsset[], assetId: string): string {
  return assets.find((asset) => asset.id === assetId)?.name ?? "";
}
