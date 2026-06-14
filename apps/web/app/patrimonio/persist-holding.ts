import type { WorthlineStore } from "@worthline/db";
import { createManualAssetSafe } from "@worthline/domain";
import type { CreateManualAssetInput, Workspace } from "@worthline/domain";

import { createStableId, type HousingCreationData, mapDomainViolation } from "../intake";

/**
 * The persistence half of creating a manual asset, shared by the per-type add
 * route (`createAssetAction`) and the unified instrument-first add flow
 * (`createHoldingAction`). It runs the domain guard, writes the asset, and — for
 * a real-estate holding with acquisition data — seeds the acquisition anchor, the
 * appreciation rate, an optional initial valuation, and ripples historical
 * snapshots from the acquisition date (PRD #108). Pure of the clock: the caller
 * passes `seed` (stable-id source) and `today`.
 */
export type ManualAssetCreation = CreateManualAssetInput & HousingCreationData;

export function persistManualAssetCreation(
  store: WorthlineStore,
  workspace: Workspace,
  command: ManualAssetCreation,
  seed: number,
  today: string,
): { ok: true; id: string } | { ok: false; error: string } {
  const {
    acquisitionDate,
    acquisitionValueMinor,
    annualAppreciationRate,
    initialValuation,
    ...assetCommand
  } = command;

  const domainResult = createManualAssetSafe(workspace, assetCommand);

  if (!domainResult.ok) {
    return { ok: false, error: mapDomainViolation(domainResult.violations[0]) };
  }

  store.assets.createManualAsset(assetCommand);

  if (assetCommand.type === "real_estate" && acquisitionDate && acquisitionValueMinor) {
    store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: assetCommand.id,
      id: createStableId("anchor", `${assetCommand.id}_acquisition`, seed),
      valuationDate: acquisitionDate,
      valueMinor: acquisitionValueMinor,
    });
    store.assets.setAnnualAppreciationRate(
      assetCommand.id,
      annualAppreciationRate ?? null,
    );

    if (initialValuation) {
      store.assets.addValuationAnchor({
        ...initialValuation,
        assetId: assetCommand.id,
        id: createStableId("anchor", `${assetCommand.id}_initial`, seed + 1),
      });
    }

    store.rippleHistoricalSnapshotsForValuation({
      assetId: assetCommand.id,
      fromDateKey: acquisitionDate,
      today,
    });
  }

  return { ok: true, id: assetCommand.id };
}
